import * as lark from "@larksuiteoapi/node-sdk";
import { loadBridgeConfig, hasCredentials } from "./config.ts";
import { SessionStore } from "./store.ts";
import { OmpSessionManager } from "./omp.ts";
import type { IncomingMessage } from "./types.ts";

/** Edit interval for streaming updates (ms). Lower = chatty, higher = laggy. */
const STREAM_INTERVAL_MS = 700;
/** Feishu text-content hard cap per message. */
const FEISHU_TEXT_LIMIT = 4000;
/** Long-connection events must finish within 3s or Feishu re-pushes. */
const ACK_WINDOW_MS = 2500;

function nowIso(): string {
	return new Date().toISOString();
}

function buildCardContent(text: string): string {
	// A simple interactive card whose body is a markdown element.
	return JSON.stringify({
		config: { wide_screen_mode: true },
		header: {
			template: "blue",
			title: { content: "omp", tag: "plain_text" },
		},
		elements: [{ tag: "markdown", content: text || "…" }],
	});
}

function truncate(text: string): string {
	const t = text.trim() || "…";
	return t.length > FEISHU_TEXT_LIMIT
		? `${t.slice(0, FEISHU_TEXT_LIMIT - 12)}\n\n*(truncated)*`
		: t;
}

class FeishuBridge {
	private readonly client: lark.Client;
	private readonly ws: lark.WSClient;
	private readonly omp: OmpSessionManager;
	private readonly store: SessionStore;
	private readonly allowed: Set<string>;
	/** Serialize per-chat so overlapping messages don't interleave. */
	private readonly queues = new Map<string, Promise<void>>();

	constructor() {
		const cfg = loadBridgeConfig();
		if (!hasCredentials(cfg)) {
			console.error(
				"Missing FEISHU_APP_ID / FEISHU_APP_SECRET. Run `bun run register-app` first.",
			);
			process.exit(1);
		}
		this.client = new lark.Client({
			appId: cfg.appId,
			appSecret: cfg.appSecret,
			domain: cfg.domain,
		});
		this.ws = new lark.WSClient({
			appId: cfg.appId,
			appSecret: cfg.appSecret,
			domain: cfg.domain,
			loggerLevel: lark.LoggerLevel.info,
		});
		this.omp = new OmpSessionManager({
			cwd: cfg.ompCwd,
			modelPattern: cfg.ompModel,
		});
		this.store = new SessionStore(
			`${cfg.ompCwd}/.feishu-omp-bridge/sessions.db`,
		);
		this.allowed = cfg.allowedOpenIds;
	}

	async run(): Promise<void> {
		const dispatcher = new lark.EventDispatcher({}).register({
			"im.message.receive_v1": async (data) => {
				// Enqueue but never block the event ACK past Feishu's re-push window.
				this.enqueue(data).catch((err) =>
					console.error("handle failed", err),
				);
			},
		});

		console.info("feishu-omp bridge starting", {
			ompCwd: loadBridgeConfig().ompCwd,
			allowed: this.allowed.size,
		});
		this.ws.start({ eventDispatcher: dispatcher });

		process.once("SIGINT", () => this.shutdown());
		process.once("SIGTERM", () => this.shutdown());
	}

	private enqueue(data: IncomingMessage): Promise<void> {
		const chatId = data.message.chat_id;
		const prev = this.queues.get(chatId) ?? Promise.resolve();
		const next = prev
			.catch(() => undefined)
			.then(() => this.handle(data))
			.catch((err) => console.error("chat handling failed", { chatId, err }))
			.finally(() => {
				if (this.queues.get(chatId) === next) this.queues.delete(chatId);
			});
		this.queues.set(chatId, next);
		return next;
	}

	private async handle(data: IncomingMessage): Promise<void> {
		// Group chats: only react when the bot is @-mentioned.
		if (data.message.chat_type === "group") {
			if (!data.message.mentions?.length) return;
		}

		const openId = data.sender.sender_id?.open_id;
		if (openId && this.allowed.size > 0 && !this.allowed.has(openId)) {
			await this.sendText(data.message.chat_id, "This omp bridge is private.");
			return;
		}

		const text = this.extractText(data.message.content);
		if (text === "/reset") {
			await this.resetChat(data.message.chat_id);
			return;
		}
		if (!text) {
			await this.sendText(data.message.chat_id, "Send text to prompt omp.");
			return;
		}

		const chatId = data.message.chat_id;
		const reply = new FeishuReply(this.client, chatId, data.message.message_id);

		try {
			await this.ensureSession(chatId);
			const full = await this.omp.prompt(chatId, text, (delta) =>
				reply.update(delta),
			);
			await reply.finish(full || "Turn complete.");
		} catch (err) {
			console.error("prompt failed", { chatId, err });
			await reply.finish(`Bridge error: ${String(err)}`);
		}
	}

	private extractText(content: string): string {
		try {
			const parsed = JSON.parse(content) as { text?: string };
			// Strip @bot mention markers that Feishu injects as <at user_id="..."></at>.
			return (parsed.text ?? "")
				.replace(/<at[^>]*>.*?<\/at>/g, "")
				.trim();
		} catch {
			return "";
		}
	}

	private async ensureSession(chatId: string): Promise<void> {
		const mapping = this.store.get(chatId);
		if (mapping) {
			try {
				await this.omp.resume(chatId, mapping.sessionFile);
				return;
			} catch (err) {
				console.warn("resume failed, recreating", { chatId, err });
			}
		}
		const managed = await this.omp.create(chatId);
		this.store.upsert({
			chatId,
			sessionFile: managed.sessionFile,
			cwd: loadBridgeConfig().ompCwd,
			createdAt: nowIso(),
			updatedAt: nowIso(),
		});
	}

	private async resetChat(chatId: string): Promise<void> {
		const mapping = this.store.get(chatId);
		if (mapping) {
			await this.omp.dispose(chatId);
			this.store.delete(chatId);
		}
		await this.sendText(chatId, "Session reset. Send a new message to start fresh.");
	}

	private async sendText(chatId: string, text: string): Promise<void> {
		await this.client.im.v1.message.create({
			params: { receive_id_type: "chat_id" },
			data: {
				receive_id: chatId,
				content: JSON.stringify({ text }),
				msg_type: "text",
			},
		});
	}

	private async shutdown(): Promise<void> {
		console.info("feishu-omp bridge shutting down…");
		await this.omp.disposeAll();
		this.store.close();
		process.exit(0);
	}
}

/** Streams omp text deltas into a Feishu card, editing it on a debounce. */
class FeishuReply {
	private cardMessageId: string | undefined;
	private latest = "";
	private rendered = "";
	private timer: ReturnType<typeof setTimeout> | undefined;
	private chain: Promise<void> = Promise.resolve();

	constructor(
		private readonly client: lark.Client,
		private readonly chatId: string,
		private readonly replyToMessageId: string,
	) {}

	update(delta: string): void {
		this.latest += delta;
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.chain = this.chain
				.then(() => this.flush())
				.catch((err) => console.warn("stream flush failed", err));
		}, STREAM_INTERVAL_MS);
	}

	async finish(finalText: string): Promise<void> {
		this.latest = finalText || this.latest || "Turn complete.";
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		await this.chain;
		await this.flush();
	}

	private async flush(): Promise<void> {
		const next = truncate(this.latest);
		if (next === this.rendered) return;
		if (!this.cardMessageId) {
			const res = await this.client.im.v1.message.create({
				params: { receive_id_type: "chat_id" },
				data: {
					receive_id: this.chatId,
					content: buildCardContent(next),
					msg_type: "interactive",
				},
			});
			this.cardMessageId = res.data?.message_id;
		} else {
			await this.client.im.v1.message.patch({
				data: { content: buildCardContent(next) },
				path: { message_id: this.cardMessageId },
			});
		}
		this.rendered = next;
	}
}

async function main(): Promise<void> {
	await new FeishuBridge().run();
}

main().catch((err) => {
	console.error("feishu-omp bridge fatal", err);
	process.exit(1);
});
