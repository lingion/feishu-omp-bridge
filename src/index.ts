import * as lark from "@larksuiteoapi/node-sdk";
import { loadConfig } from "./config-loader.ts";
import { AccessControl } from "./access.ts";
import { FeishuMedia } from "./media.ts";
import { OmpSessionManager } from "./omp.ts";
import { CommandRegistry, type OverrideStore } from "./commands.ts";
import { DeliveryLedger } from "./ledger.ts";
import { SessionStore } from "./store.ts";
import { scopeKey, isBotSender } from "./scope.ts";
import { buildToolsetArg, anyToolsEnabled } from "./feishu-tools.ts";
import { install as installService, uninstall as uninstallService } from "./service.ts";
import { ChatLocks, CardActionDedup } from "./concurrency.ts";
import { parsePostPayload, buildMarkdownPostPayload } from "./rich.ts";
import { FeishuEvents } from "./events.ts";
import { hydrateBotIdentity, messageMentionsBot, type BotIdentity } from "./mentions.ts";
import type { IncomingMessage } from "./types.ts";
import { SenderResolver } from "./sender.ts";

const FEISHU_TEXT_LIMIT = 4000;

/** Persisted per-chat model overrides, backed by the session store. */
class ModelOverrideStore implements OverrideStore {
	private readonly store: SessionStore;
	constructor(store: SessionStore) {
		this.store = store;
	}
	getModel(chatId: string): string | undefined {
		return this.store.getModelOverride(chatId);
	}
	setModel(chatId: string, model: string | undefined): void {
		this.store.setModelOverride(chatId, model);
	}
}

class FeishuBridge {
	private readonly cfg;
	private readonly client: lark.Client;
	private readonly ws: lark.WSClient;
	private readonly omp: OmpSessionManager;
	private readonly access: AccessControl;
	private readonly media: FeishuMedia;
	private readonly commands: CommandRegistry;
	private readonly ledger: DeliveryLedger;
	private readonly store: SessionStore;
	private readonly overrides: ModelOverrideStore;
	private readonly chatLocks = new ChatLocks();
	private readonly cardDedup = new CardActionDedup();
	private bot: BotIdentity = {};
	private readonly events!: FeishuEvents;
	private senderResolver!: SenderResolver;
	private readonly queues = new Map<string, Promise<void>>();

	constructor() {
		const cfg = loadConfig();
		this.cfg = cfg;
		this.client = new lark.Client({
			appId: cfg.appId,
			appSecret: cfg.appSecret,
			domain: cfg.domainUrl,
		});
		this.ws = new lark.WSClient({
			appId: cfg.appId,
			appSecret: cfg.appSecret,
			domain: cfg.domainUrl,
			loggerLevel: lark.LoggerLevel.info,
		});
		this.omp = new OmpSessionManager({ cwd: cfg.ompCwd, modelPattern: cfg.ompModel });
		this.store = new SessionStore(cfg.sessionDbPath);
		this.overrides = new ModelOverrideStore(this.store);
		this.access = new AccessControl(cfg);
		this.media = new FeishuMedia(this.client, {
			mediaMaxMb: cfg.mediaMaxMb,
			dataDir: cfg.dataDir,
		});
		this.senderResolver = new SenderResolver(this.client);
		this.commands = new CommandRegistry(cfg, this.overrides);
		this.events = new FeishuEvents({
			client: this.client,
			cfg,
			notify: (chatId, title, body) => this.sendCard(chatId, title, body),
		});
		this.ledger = cfg.deliveryLedger ? new DeliveryLedger(cfg.ledgerDbPath) : null!;
	}

	async run(): Promise<void> {
		// Hydrate bot identity for precise @bot detection (Hermes _hydrate_bot_identity).
		this.bot = await hydrateBotIdentity(this.client);
		console.info("[bot-identity] open_id:", this.bot.openId ?? "(unknown)", "name:", this.bot.name ?? "(unknown)");
		// Redeliver any replies orphaned by a previous crash.
		if (this.cfg.deliveryLedger) await this.redeliverPending();

		// Report Feishu tool scope guidance once at startup if enabled.
		if (anyToolsEnabled(this.cfg)) {
			const toolset = buildToolsetArg(this.cfg);
			console.info("[feishu-tools] lark-mcp toolset:", toolset || "(none)");
		}

		const dispatcher = new lark.EventDispatcher({}).register({
			"im.message.receive_v1": async (data) => {
				this.enqueue(data).catch((e) => console.error("handle failed", e));
			},
			// swallow reaction events from our own typing indicator
			"im.message.reaction.created_v1": () => {},
			"im.message.reaction.deleted_v1": () => {},
			"im.chat.member.bot.added_v1": (d) =>
				void this.events.onBotAdded(readStr(d, "chat_id")),
			"im.chat.member.bot.deleted_v1": (d) =>
				void this.events.onBotRemoved(readStr(d, "chat_id")),
			"im.message.recalled_v1": (d) =>
				void this.events.onMessageRecalled(readStr(d, "message_id")),
			"im.message.message_read_v1": (d) => {
				const reader = readObj(d, "reader_id");
				void this.events.onMessageRead(readStr(reader, "open_id"));
			},
			"drive.notice.comment_add_v1": (d) => {
				const commenter = readObj(d, "commenter");
				void this.events.onDriveComment(readStr(d, "doc_token") || "?", readStr(commenter, "name") || "?");
			},
			"vc.meeting.meeting.created_v1": (d: unknown) => {
				const meeting = readObj(d, "meeting");
				void this.events.onMeetingInvited(readStr(meeting, "topic") || "?", readStr(meeting, "start_time"));
			},
		});

		console.info("feishu-omp bridge starting", {
			domain: this.cfg.domain,
			ompCwd: this.cfg.ompCwd,
			dmPolicy: this.cfg.dmPolicy,
			groupPolicy: this.cfg.groupPolicy,
			streaming: this.cfg.streaming.mode,
		});
		this.ws.start({ eventDispatcher: dispatcher });

		process.once("SIGINT", () => void this.shutdown());
		process.once("SIGTERM", () => void this.shutdown());
	}

	private enqueue(data: IncomingMessage): Promise<void> {
		const key = scopeKey(
			this.cfg.groupSessionScope,
			data.message.chat_type,
			data.message.chat_id,
			data.sender.sender_id?.open_id ?? "?",
			data.message.thread_id,
		);
		const prev = this.queues.get(key) ?? Promise.resolve();
		const next = prev
			.catch(() => undefined)
			.then(() => this.handle(data, key))
			.catch((err) => console.error("chat handling failed", { key, err }))
			.finally(() => {
				if (this.queues.get(key) === next) this.queues.delete(key);
			});
		this.queues.set(key, next);
		return next;
	}

	private async handle(data: IncomingMessage, key: string): Promise<void> {
		// Bot loop protection: ignore other bots unless allowBots.
		if (isBotSender(data.sender.sender_type) && !this.cfg.allowBots) {
			console.error(`[skip] bot sender ignored key=${key}`);
			return;
		}
		const openId = data.sender.sender_id?.open_id ?? "";
		const isGroup = data.message.chat_type === "group";
		const mentionedBot = messageMentionsBot(data, this.bot);
		console.error(
			`[inbound] key=${key} type=${data.message.message_type} ` +
				`chatType=${data.message.chat_type} from=${openId} mentionedBot=${mentionedBot} mid=${data.message.message_id}`,
		);


		// Access control.
		const decision = isGroup
			? this.access.authorizeGroup(data.message.chat_id, openId, mentionedBot)
			: this.access.authorizeDm(openId);
		console.error(
			`[access] key=${key} policy=${isGroup ? "group" : "dm"} -> ` +
				(decision.allowed ? "allow" : `deny:${decision.reason}`),
		);
		if (!decision.allowed) {
			if (decision.pairingCode) {
				await this.sendText(data.message.chat_id, decision.reason);
			}
			return;
		}

		// Typing indicator (best-effort).
		if (this.cfg.typingIndicator) {
			void this.media.typing(data.message.message_id);
		}

		try {
		const { text, images } = await this.extractContent(data);
		console.error(`[content] key=${key} text=${JSON.stringify(text.slice(0, 60))} (${text.length}c) images=${images.length}`);
			// Slash commands route first.
			if (text.startsWith("/")) {
				const routed = await this.commands.route(text, {
					chatId: data.message.chat_id,
					openId,
					args: "",
					reply: (t) => this.sendText(data.message.chat_id, t),
					omp: this.omp,
					access: this.access,
				});
				if (routed.handled) {
					if (routed.output) await this.sendText(data.message.chat_id, routed.output);
					return;
				}
			}

			if (!text && images.length === 0) {
				await this.sendText(data.message.chat_id, "Send text or an image.");
				return;
			}

		await this.ensureSession(key);
		// Inject sender display name into omp context when enabled (Hermes resolveSenderNames).
		let promptText = text || "(analyze this image)";
		if (this.cfg.resolveSenderNames && openId) {
			const name = await this.senderResolver.resolveName(openId);
			if (name) promptText = `[from ${name}] ${promptText}`;
		}
		const reply = new FeishuReply(this.client, data.message.chat_id, this.cfg, data.message.message_id);
		console.error(`[prompt] key=${key} model=${this.overrides.getModel(key) ?? this.cfg.ompModel ?? "(default)"}`);
		const full = await this.omp.prompt(
			key,
			promptText,
			(delta) => reply.update(delta),
			images,
		);
			await reply.finish(full || "Turn complete.");
			console.error(`[reply] key=${key} len=${full.length}c preview=${JSON.stringify(full.slice(0, 120))}`);
		} finally {
			if (this.cfg.typingIndicator) {
				void this.media.clearTyping(data.message.message_id);
			}
		}
	}

	/** Extract text + any image attachments from an inbound message. */
	private async extractContent(
		data: IncomingMessage,
	): Promise<{
		text: string;
		images: Array<{ data: string; mimeType: string }>;
	}> {
		const msgType = data.message.message_type;
		const content = data.message.content;
		if (msgType === "text") {
			try {
				const text = (JSON.parse(content).text ?? "").replace(/<at[^>]*>.*?<\/at>/g, "").trim();
				return { text, images: [] };
			} catch {
				return { text: "", images: [] };
			}
		}
		if (msgType === "image") {
			try {
				const fileKey = JSON.parse(content).image_key;
				const att = await this.media.download(data.message.message_id, fileKey, "image");
				return { text: "", images: [{ data: att.data, mimeType: att.mimeType }] };
			} catch (err) {
				console.error("image download failed", err);
				return { text: "", images: [] };
			}
		}
		if (msgType === "post") {
			// Rich text: flatten to plain text for omp.
			return { text: parsePostPayload(content), images: [] };
		}
		if (msgType === "file" || msgType === "audio" || msgType === "video" || msgType === "media") {
			// Hermes model: download to a persistent path; inline text/.md content,
			// else placeholder + tell omp where the file is so its tools can read it.
			try {
				const fileKey = JSON.parse(content).file_key ?? "";
				const fileName = JSON.parse(content).file_name ?? fileKey;
				if (!fileKey) return { text: `(received a ${msgType} message)`, images: [] };
				const saved = await this.media.downloadToPath(
					data.message.message_id,
					fileKey,
					"file",
					fileName,
				);
				const inline = await this.inlineTextIfSmall(saved.path, saved.mimeType);
				if (inline) {
					return { text: `[Content of ${saved.fileName}]:\n${inline}`, images: [] };
				}
				return {
					text:
						`[Attachment: ${saved.fileName}] (saved to ${saved.path}) ` +
						`— use the read tool to open it if you need its contents.`,
					images: [],
				};
			} catch (err) {
				console.error(`${msgType} download failed`, err);
				return { text: `(received a ${msgType} message; download failed)`, images: [] };
			}
		}
		if (msgType === "sticker") {
			try {
				const fileKey = JSON.parse(content).file_key ?? "";
				if (fileKey) {
					const att = await this.media.download(data.message.message_id, fileKey, "image");
					return { text: "(received a sticker)", images: [{ data: att.data, mimeType: att.mimeType }] };
				}
			} catch {
				/* fall through */
			}
			return { text: "(received a sticker)", images: [] };
		}
		return { text: `(received a ${msgType} message; type not fully supported)`, images: [] };
	}

	/** Inline small text/.md file content (Hermes `_maybe_extract_text_document`). */
	private async inlineTextIfSmall(path: string, mimeType: string): Promise<string | null> {
		const MAX = 64 * 1024; // 64 KiB cap
		try {
			const stat = await Bun.file(path).stat();
			if (stat.size > MAX) return null;
			const ext = path.split(".").pop()?.toLowerCase() ?? "";
			const isText =
				ext === "txt" || ext === "md" ||
				mimeType === "text/plain" || mimeType === "text/markdown";
			if (!isText) return null;
			return await Bun.file(path).text();
		} catch {
			return null;
		}
	}
	private async ensureSession(key: string): Promise<void> {
		const mapping = this.store.get(key);
		if (mapping) {
			try {
				await this.omp.resume(key, mapping.sessionFile);
				return;
			} catch (err) {
				console.warn("resume failed, recreating", { key, err });
			}
		}
		const managed = await this.omp.create(key);
		this.store.upsert({
			chatId: key,
			sessionFile: managed.sessionFile,
			cwd: this.cfg.ompCwd,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
	}

	private async sendText(chatId: string, text: string): Promise<void> {
		await this.client.im.v1.message.create({
			params: { receive_id_type: "chat_id" },
			data: { receive_id: chatId, content: JSON.stringify({ text }), msg_type: "text" },
		});
	}

	/** Send an interactive card with a title + markdown body (used by events.notify). */
	private async sendCard(chatId: string, title: string, body: string): Promise<void> {
		const card = {
			config: { wide_screen_mode: true },
			header: { template: "orange", title: { content: title, tag: "plain_text" } },
			elements: [{ tag: "markdown", content: body }],
		};
		await this.client.im.v1.message.create({
			params: { receive_id_type: "chat_id" },
			data: { receive_id: chatId, content: JSON.stringify(card), msg_type: "interactive" },
		});
	}
	/** Redeliver replies orphaned by a crash before platform confirmation. */
	private async redeliverPending(): Promise<void> {
		const pending = this.ledger.pendingRedelivery();
		for (const row of pending) {
			const text = row.recovered ? `♻️ Recovered reply (may be a duplicate):\n${row.text}` : row.text;
			await this.sendText(row.chatId, text);
			this.ledger.markDelivered(row.id);
		}
		if (pending.length > 0) console.info(`[ledger] redelivered ${pending.length} orphaned replies`);
	}

	private async shutdown(): Promise<void> {
		console.info("feishu-omp bridge shutting down…");
		await this.omp.disposeAll();
		this.store.close();
		this.access.close();
		if (this.cfg.deliveryLedger) this.ledger.close();
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
		private readonly cfg: { streamIntervalMs: number; streaming: { mode: string }; replyInThread: string },
		private readonly replyToMessageId?: string,
	) {}
	update(delta: string): void {
		if (this.cfg.streaming.mode === "off") return; // one-shot mode: buffer only
		this.latest += delta;
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.chain = this.chain.then(() => this.flush()).catch((e) =>
				console.warn("stream flush failed", e),
			);
		}, this.cfg.streamIntervalMs);
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
			const content = buildCardContent(next);
			const res = this.replyToMessageId
				? await this.client.im.v1.message.reply({
						data: {
							content,
							msg_type: "interactive",
							// replyInThread enabled: root reply creates a topic thread;
							// subsequent group messages in that thread route to the same omp
							// session via groupSessionScope: group_topic (scopeKey uses thread_id).
							reply_in_thread: this.cfg.replyInThread === "enabled",
						},
						path: { message_id: this.replyToMessageId },
					})
				: await this.client.im.v1.message.create({
						params: { receive_id_type: "chat_id" },
						data: { receive_id: this.chatId, content, msg_type: "interactive" },
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

/** Read a string field from an unknown event payload (type-safe, no any). */
function readStr(obj: unknown, key: string): string {
	return typeof obj === "object" && obj !== null && key in obj && typeof (obj as Record<string, unknown>)[key] === "string"
		? ((obj as Record<string, unknown>)[key] as string)
		: "";
}
/** Read an object field from an unknown payload, or null. */
function readObj(obj: unknown, key: string): unknown {
	return typeof obj === "object" && obj !== null && key in obj && typeof (obj as Record<string, unknown>)[key] === "object"
		? (obj as Record<string, unknown>)[key]
		: null;
}

function buildCardContent(text: string): string {
	return JSON.stringify({
		config: { wide_screen_mode: true },
		header: { template: "blue", title: { content: "omp", tag: "plain_text" } },
		elements: [{ tag: "markdown", content: text || "…" }],
	});
}

function truncate(text: string): string {
	const t = text.trim() || "…";
	return t.length > FEISHU_TEXT_LIMIT ? `${t.slice(0, FEISHU_TEXT_LIMIT - 12)}\n\n*(truncated)*` : t;
}

async function main(): Promise<void> {
	// `bridge service install|uninstall` manages the launchd agent.
	const sub = process.argv[2];
	if (sub === "service") {
		const action = process.argv[3];
		const bun = process.argv[0];
		const script = process.argv[1];
		const cwd = process.cwd();
		if (action === "install") {
			console.log("installed:", installService(bun, script, cwd));
		} else if (action === "uninstall") {
			uninstallService();
			console.log("uninstalled");
		} else {
			console.log("usage: bun run src/index.ts service [install|uninstall]");
		}
		return;
	}
	await new FeishuBridge().run();
}

main().catch((err) => {
	console.error("feishu-omp bridge fatal", err);
	process.exit(1);
});
