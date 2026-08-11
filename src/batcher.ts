/**
 * Per-chat message batcher, ported from Hermes `_schedule_text_batch_flush` /
 * `_flush_text_batch`. Rapid consecutive messages coalesce into a single omp
 * turn instead of each one interrupting the agent.
 *
 * Behavior:
 * - Each new message resets a debounce timer (default 600ms quiet period).
 * - Flush immediately when hitting MAX_MESSAGES or MAX_CHARS.
 * - Adaptive delay: when the latest chunk is near Feishu's ~4096-char split
 *   point, wait longer (a continuation chunk is almost certain).
 */
export type BatchedItem = {
	chatId: string;
	text: string;
	images: Array<{ data: string; mimeType: string }>;
};

export type BatchConfig = {
	delayMs: number;
	mediaDelayMs: number;
	splitDelayMs: number;
	maxMessages: number;
	maxChars: number;
	splitThreshold: number;
};

export const DEFAULT_BATCH_CONFIG: BatchConfig = {
	delayMs: 600,
	mediaDelayMs: 800,
	splitDelayMs: 2000,
	maxMessages: 8,
	maxChars: 4000,
	splitThreshold: 3000,
};

/** Batcher per chat: accumulate items, flush on quiet period or capacity. */
export class MessageBatcher {
	private readonly cfg: BatchConfig;
	private readonly onFlush: (chatId: string, items: BatchedItem[]) => Promise<void>;
	private readonly buffers = new Map<string, BatchedItem[]>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(cfg: Partial<BatchConfig>, onFlush: (chatId: string, items: BatchedItem[]) => Promise<void>) {
		this.cfg = { ...DEFAULT_BATCH_CONFIG, ...cfg };
		this.onFlush = onFlush;
	}

	/** Add an item; schedules (or fires) a flush per the debounce/capacity rules. */
	add(chatId: string, item: BatchedItem): void {
		const buf = this.buffers.get(chatId) ?? [];
		buf.push(item);
		this.buffers.set(chatId, buf);

	const totalChars = buf.reduce((n, it) => n + it.text.length, 0);
	if (buf.length >= this.cfg.maxMessages || totalChars >= this.cfg.maxChars) {
		this.flushNow(chatId);
		return;
	}
	const hasImages = buf.some((it) => it.images.length > 0);
	this.schedule(chatId, item.text.length, hasImages);
	}

	/** Force-flush a chat immediately (e.g. on shutdown). */
	flushNow(chatId: string): void {
		const t = this.timers.get(chatId);
		if (t) {
			clearTimeout(t);
			this.timers.delete(chatId);
		}
		const items = this.buffers.get(chatId);
		if (!items || items.length === 0) return;
		this.buffers.delete(chatId);
		void this.onFlush(chatId, items).catch((e) => console.error("batch flush failed", e));
	}

	/** Flush everything (shutdown). */
	flushAll(): void {
		for (const chatId of this.timers.keys()) this.flushNow(chatId);
	}

	private schedule(chatId: string, lastChunkLen: number, hasMedia?: boolean): void {
		// Adaptive: near the split threshold, wait longer; media items use mediaDelayMs.
		const delay = hasMedia
			? this.cfg.mediaDelayMs
			: lastChunkLen >= this.cfg.splitThreshold
				? this.cfg.splitDelayMs
				: this.cfg.delayMs;
		const existing = this.timers.get(chatId);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => this.flushNow(chatId), delay);
		timer.unref?.();
		this.timers.set(chatId, timer);
	}
}

/** Merge batched items into a single omp prompt: text concatenated, images collected. */
export function mergeBatched(items: BatchedItem[]): { text: string; images: Array<{ data: string; mimeType: string }> } {
	const text = items.map((it) => it.text).join("\n\n");
	const images = items.flatMap((it) => it.images);
	return { text, images };
}
