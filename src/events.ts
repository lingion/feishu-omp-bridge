import type * as lark from "@larksuiteoapi/node-sdk";
import type { ResolvedConfig } from "./config-types.ts";

/**
 * Non-message event handlers, ported from Hermes `_on_*` methods.
 *
 * omp has NO blocking approval hook (its approval is a synchronous policy over
 * mode + config, not an await-able gate). So unlike Hermes, our
 * `tool_approval_requested` handler can only send a *notification* card — the
 * approve/deny buttons cannot actually intercept omp (documented limitation).
 *
 * These handlers log + optionally notify, matching Hermes' behavior for events
 * that don't drive an agent turn (bot added/removed, recall, read, drive
 * comment, meeting invite).
 */
export type EventHandlerDeps = {
	client: lark.Client;
	cfg: ResolvedConfig;
	/** Send a notification card to a chat (best-effort). */
	notify: (chatId: string, title: string, body: string) => Promise<void>;
};

export class FeishuEvents {
	private readonly deps: EventHandlerDeps;
	constructor(deps: EventHandlerDeps) {
		this.deps = deps;
	}

	/** Bot was added to a group. */
	async onBotAdded(chatId: string): Promise<void> {
		console.error(`[event] bot added to chat ${chatId}`);
		// Hermes greets; we keep it quiet to avoid noise unless groupPolicy is open.
	}

	/** Bot was removed from a group. */
	async onBotRemoved(chatId: string): Promise<void> {
		console.error(`[event] bot removed from chat ${chatId}`);
	}

	/** A message was recalled — informational only. */
	async onMessageRecalled(messageId: string): Promise<void> {
		console.error(`[event] message recalled ${messageId}`);
	}

	/** Read receipts — Hermes tracks for session bookkeeping; we just log. */
	async onMessageRead(openId: string): Promise<void> {
		// Very noisy; debug-level only.
		if (this.deps.cfg.resolveSenderNames) {
			console.error(`[event] messages read by ${openId}`);
		}
	}

	/** A drive document received a comment — notify the document owner's chat if configured. */
	async onDriveComment(docName: string, commenter: string): Promise<void> {
		console.error(`[event] drive comment on "${docName}" by ${commenter}`);
	}

	/** Bot was invited to a VC meeting. Notify home channel if vcAutoJoin is off. */
	async onMeetingInvited(meetingTopic: string, startTime?: string): Promise<void> {
		console.error(`[event] meeting invite: ${meetingTopic} @ ${startTime ?? "?"}`);
	}

	/** omp requested tool approval — notification-only (omp can't be blocked externally). */
	async onToolApprovalRequested(
		chatId: string,
		toolName: string,
		reason: string | undefined,
	): Promise<void> {
		const title = "⚠️ Tool Approval (notification)";
		const body = `omp wants to run **${toolName}**\n${reason ? `\n_${reason}_` : ""}\n\n_(omp's approval is policy-driven; this card is informational only — buttons cannot intercept it.)_`;
		await this.deps.notify(chatId, title, body);
		console.error(`[approval-notify] ${toolName} for ${chatId}`);
	}
}
