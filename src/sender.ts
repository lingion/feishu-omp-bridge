import type * as lark from "@larksuiteoapi/node-sdk";

/**
 * Sender display-name resolution with TTL cache, ported from Hermes
 * `_resolve_sender_name_from_api`. Uses contact.v3.user.get (open_id → name).
 * Failures are silent so the pipeline never blocks on name resolution.
 */
export class SenderResolver {
	private readonly client: lark.Client;
	private readonly cache = new Map<string, { name: string; expiresAt: number }>();
	private readonly ttlMs: number;
	constructor(client: lark.Client, ttlSeconds = 3600) {
		this.client = client;
		this.ttlMs = ttlSeconds * 1000;
	}

	/** Resolve a display name for an open_id (cached). Returns "" if nameless/failed. */
	async resolveName(openId: string): Promise<string> {
		if (!openId) return "";
		const hit = this.cache.get(openId);
		if (hit && hit.expiresAt > Date.now()) return hit.name;
		let name = "";
		try {
			const res = await this.client.contact.v3.user.get({
				params: { user_id_type: "open_id" },
				path: { user_id: openId },
			});
			const user = res?.data?.user as
				| { name?: string; display_name?: string; nickname?: string }
				| undefined;
			name = user?.name ?? user?.display_name ?? user?.nickname ?? "";
		} catch {
			// silent: name resolution never blocks the pipeline
		}
		this.cache.set(openId, { name, expiresAt: Date.now() + this.ttlMs });
		return name;
	}
}
