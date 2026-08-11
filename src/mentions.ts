import type * as lark from "@larksuiteoapi/node-sdk";
import type { IncomingMessage } from "./types.ts";

/**
 * Bot identity + precise @bot detection, ported from Hermes
 * `_hydrate_bot_identity` / `_mentions_self` / `_message_mentions_bot`.
 *
 * The naive "mentions.length > 0" check wrongly fires when a user @mentions
 * someone else. The correct test: a mention's open_id equals the bot's open_id
 * (or the content contains @_all). Bot identity is hydrated once at startup via
 * /bot/v3/info (no extra scopes beyond tenant access token).
 */
export type BotIdentity = {
	openId?: string;
	name?: string;
};

/** Fetch bot identity at startup (best-effort). */
export async function hydrateBotIdentity(client: lark.Client): Promise<BotIdentity> {
	try {
		const res = await client.request<{
			bot?: { open_id?: string; app_name?: string };
		}>({
			method: "GET",
			url: "/open-apis/bot/v3/info",
		});
		const bot = res?.bot;
		if (bot?.open_id) {
			return { openId: bot.open_id, name: bot.app_name };
		}
	} catch (err) {
		console.error("[bot-identity] hydrate failed:", String(err).slice(0, 120));
	}
	return {};
}

/** True if an inbound message @mentions the bot (or @all). */
export function messageMentionsBot(data: IncomingMessage, bot: BotIdentity): boolean {
	const content = data.message.content ?? "";
	if (content.includes("@_all")) return true;
	const mentions = data.message.mentions ?? [];
	for (const m of mentions) {
		// ID match takes precedence; name fallback only when no ID on either side.
		const mentionOpenId = m.id?.open_id?.trim();
		if (mentionOpenId && bot.openId) {
			if (mentionOpenId === bot.openId) return true;
			continue; // IDs differ — not the bot; skip name fallback.
		}
		if (bot.name && (m.name ?? "").trim() === bot.name) return true;
	}
	return false;
}
