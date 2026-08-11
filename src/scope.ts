import type { GroupSessionScope } from "./config-types.ts";

/**
 * Compute the session scope key for an inbound message.
 *
 * Mirrors OpenClaw's `groupSessionScope`:
 * - DMs always key by open_id (one session per user).
 * - Groups key by chat_id, optionally combined with sender or topic thread.
 *
 * @returns the scope key used to look up / create an omp session.
 */
export function scopeKey(
	scope: GroupSessionScope,
	chatType: string,
	chatId: string,
	openId: string,
	threadId?: string,
): string {
	if (chatType === "p2p") return `dm:${openId}`;
	switch (scope) {
		case "group":
			return `grp:${chatId}`;
		case "group_sender":
			return `grp:${chatId}:u:${openId}`;
		case "group_topic":
			return threadId ? `grp:${chatId}:t:${threadId}` : `grp:${chatId}`;
		case "group_topic_sender":
			return threadId
				? `grp:${chatId}:t:${threadId}:u:${openId}`
				: `grp:${chatId}:u:${openId}`;
	}
}

export function isBotSender(senderType: string | undefined): boolean {
	return senderType === "app" || !!senderType?.includes("bot");
}
