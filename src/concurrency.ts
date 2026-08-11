/**
 * Per-chat serialization lock + card-action dedup, ported from Hermes
 * `_get_chat_lock` / `_is_card_action_duplicate`.
 *
 * The chat lock is an LRU-bounded map of Promises: messages in the SAME chat
 * run one at a time, different chats run concurrently. Card-action dedup
 * prevents a double-tap on an interactive card from processing twice.
 */

const CHAT_LOCK_MAX_SIZE = 256;

/** Bounded LRU of in-flight per-chat promise chains. */
export class ChatLocks {
	private readonly chains = new Map<string, Promise<void>>();

	/** Run `fn` after any prior chain for `chatId` settles; serializes per chat. */
	async run<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.chains.get(chatId) ?? Promise.resolve();
		let resolveNext!: () => void;
		const next = new Promise<void>((r) => {
			resolveNext = r;
		});
		this.evictIfNeeded();
		// Refresh LRU position, then chain this turn after the prior one settles.
		this.chains.delete(chatId);
		this.chains.set(chatId, next);
		try {
			await prev.catch(() => undefined);
			return await fn();
		} finally {
			resolveNext();
			if (this.chains.get(chatId) === next) this.chains.delete(chatId);
		}
	}

	private evictIfNeeded(): void {
		if (this.chains.size < CHAT_LOCK_MAX_SIZE) return;
		const firstKey = this.chains.keys().next().value;
		if (firstKey !== undefined) this.chains.delete(firstKey);
	}
}

/** Token-bucket dedup for card-action triggers (Hermes `_is_card_action_duplicate`). */
export class CardActionDedup {
	private readonly seen = new Set<string>();
	private readonly ttlMs: number;
	constructor(ttlMs = 60_000) {
		this.ttlMs = ttlMs;
	}
	/** Returns true if token was already seen (duplicate); false + records it. */
	isDuplicate(token: string): boolean {
		if (this.seen.has(token)) return true;
		this.seen.add(token);
		setTimeout(() => this.seen.delete(token), this.ttlMs).unref?.();
		return false;
	}
}
