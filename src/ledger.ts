import { Database } from "bun:sqlite";

/**
 * At-least-once delivery ledger (aligned with Hermes `state.db` delivery ledger).
 *
 * Before sending a final agent reply, the bridge records {chatId, text} here.
 * If the process dies before the platform confirms receipt, the next boot
 * redelivers pending rows. Delivered rows are pruned after a freshness window.
 *
 * Semantics:
 * - never-started send: redelivered as-is.
 * - mid-send crash (ambiguous): caller marks it `recovered` so redelivery shows
 *   a "♻️ may be a duplicate" prefix.
 * - bounded: rows older than `freshnessHours` are abandoned; delivered rows
 *   pruned after `pruneDays`.
 */

type LedgerRow = {
	id: number;
	chat_id: string;
	text: string;
	status: "pending" | "delivered" | "recovered";
	created_at: number;
	delivered_at: number | null;
};

export class DeliveryLedger {
	private readonly db: Database;
	private readonly pruneDays: number;
	private readonly freshnessMs: number;

	constructor(path: string, pruneDays = 7, freshnessHours = 24) {
		this.db = new Database(path, { create: true });
		this.pruneDays = pruneDays;
		this.freshnessMs = freshnessHours * 3600_000;
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS delivery (
				id           INTEGER PRIMARY KEY AUTOINCREMENT,
				chat_id      TEXT NOT NULL,
				text         TEXT NOT NULL,
				status       TEXT NOT NULL,
				created_at   INTEGER NOT NULL,
				delivered_at INTEGER
			);
		`);
	}

	/** Record a reply about to be sent; returns its ledger id. */
	enqueue(chatId: string, text: string): number {
		const res = this.db
			.prepare(
				"INSERT INTO delivery (chat_id, text, status, created_at) VALUES (?, ?, 'pending', ?)",
			)
			.run(chatId, text, Date.now());
		return Number(res.lastInsertRowid);
	}

	/** Mark a send confirmed; schedules pruning. */
	markDelivered(id: number): void {
		this.db
			.prepare("UPDATE delivery SET status = 'delivered', delivered_at = ? WHERE id = ?")
			.run(Date.now(), id);
		this.prune();
	}

	/** Mark a send as ambiguous (mid-send crash). Next boot prefixes redelivery. */
	markRecovered(id: number): void {
		this.db.prepare("UPDATE delivery SET status = 'recovered' WHERE id = ?").run(id);
	}

	/** Rows still pending/recovered and within the freshness window. */
	pendingRedelivery(): Array<{ id: number; chatId: string; text: string; recovered: boolean }> {
		const cutoff = Date.now() - this.freshnessMs;
		const rows = this.db
			.prepare(
				"SELECT id, chat_id, text, status, created_at FROM delivery " +
					"WHERE status IN ('pending','recovered') AND created_at >= ? ORDER BY created_at",
			)
			.all(cutoff) as Array<LedgerRow>;
		return rows.map((r) => ({
			id: r.id,
			chatId: r.chat_id,
			text: r.text,
			recovered: r.status === "recovered",
		}));
	}

	/** Drop delivered rows older than pruneDays and stale pending rows. */
	private prune(): void {
		const pruneCutoff = Date.now() - this.pruneDays * 86400_000;
		this.db
			.prepare("DELETE FROM delivery WHERE status = 'delivered' AND delivered_at < ?")
			.run(pruneCutoff);
		this.db.prepare("DELETE FROM delivery WHERE created_at < ?").run(
			Date.now() - this.freshnessMs,
		);
	}

	close(): void {
		this.db.close();
	}
}
