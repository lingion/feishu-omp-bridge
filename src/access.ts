import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import type { ResolvedConfig } from "./config-types.ts";

export type AccessDecision =
	| { allowed: true; tier: "admin" | "user" }
	| { allowed: false; reason: string; pairingCode?: string };

/** Pending + approved pairing entries, persisted across restarts. */
class PairingStore {
	private readonly db: Database;
	constructor(path: string) {
		this.db = new Database(path, { create: true });
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS pairings (
				code        TEXT PRIMARY KEY,
				open_id     TEXT,
				status      TEXT NOT NULL,  -- 'pending' | 'approved'
				created_at  INTEGER NOT NULL,
				approved_at INTEGER
			);
		`);
	}
	/** Create a fresh pending code, expiring stale ones first. */
	createCode(openId: string, ttlSeconds: number): string {
		const code = randomBytes(4).toString("hex").toUpperCase();
		this.db
			.prepare(
				"INSERT INTO pairings (code, open_id, status, created_at) VALUES (?, ?, 'pending', ?)",
			)
			.run(code, openId, Date.now());
		this.expire(ttlSeconds);
		return code;
	}
	/** Approve by code; returns the bound open_id or null if not found/expired. */
	approve(code: string, ttlSeconds: number): string | null {
		this.expire(ttlSeconds);
		const row = this.db
			.prepare("SELECT open_id FROM pairings WHERE code = ? AND status = 'pending'")
			.get(code) as { open_id: string } | null;
		if (!row) return null;
		this.db
			.prepare("UPDATE pairings SET status = 'approved', approved_at = ? WHERE code = ?")
			.run(Date.now(), code);
		return row.open_id;
	}
	/** List pending codes with their bound open_id, for CLI approval. */
	pending(): Array<{ code: string; openId: string }> {
		const rows = this.db
			.prepare("SELECT code, open_id FROM pairings WHERE status = 'pending'")
			.all() as Array<{ code: string; open_id: string }>;
		return rows.map((r) => ({ code: r.code, openId: r.open_id }));
	}
	/** Remove pending codes older than ttl. */
	private expire(ttlSeconds: number): void {
		const cutoff = Date.now() - ttlSeconds * 1000;
		this.db.prepare("DELETE FROM pairings WHERE status = 'pending' AND created_at < ?").run(cutoff);
	}
	close(): void {
		this.db.close();
	}
}

export class AccessControl {
	private readonly pairing: PairingStore;
	private readonly cfg: ResolvedConfig;

	constructor(cfg: ResolvedConfig) {
		this.cfg = cfg;
		this.pairing = new PairingStore(cfg.pairingDbPath);
	}

	/** Decide whether a DM sender may drive the bot. */
	authorizeDm(openId: string): AccessDecision {
		const tier = this.tier(openId);
		switch (this.cfg.dmPolicy) {
			case "open":
				return { allowed: true, tier };
			case "allowlist":
				if (this.cfg.allowFrom.includes(openId) || this.cfg.allowFrom.includes("*")) {
					return { allowed: true, tier };
				}
				return { allowed: false, reason: "not on DM allowlist" };
			case "pairing": {
				if (this.cfg.allowFrom.includes(openId)) return { allowed: true, tier };
				// Generate a fresh code per unknown sender; OpenClaw rate-limits similarly.
				const code = this.pairing.createCode(openId, this.cfg.pairingTtlSeconds);
				return {
					allowed: false,
					reason: `Unknown user. Pairing code: ${code}`,
					pairingCode: code,
				};
			}
		}
	}

	/** Decide whether a group chat + sender should be processed. */
	authorizeGroup(
		chatId: string,
		openId: string,
		mentionedBot: boolean,
	): AccessDecision {
		if (this.cfg.groupPolicy === "disabled") {
			return { allowed: false, reason: "group access disabled" };
		}
		const tier = this.tier(openId);

		// Mention gate (unless group policy open or per-group override).
		const grp = this.cfg.groups[chatId];
		const needMention = this.effectiveRequireMention(chatId);
		if (needMention && !mentionedBot) {
			return { allowed: false, reason: "bot not @-mentioned" };
		}

		// Group membership gate.
		if (this.cfg.groupPolicy === "allowlist") {
			const admitted =
				this.cfg.groupAllowFrom.includes(chatId) || this.cfg.groups[chatId] !== undefined;
			if (!admitted) return { allowed: false, reason: "group not on allowlist" };
		}

		// Per-group sender allowlist (overrides global groupSenderAllowFrom).
		const groupSenderAllow =
			grp?.allowFrom ?? (this.cfg.groupSenderAllowFrom.length > 0
				? this.cfg.groupSenderAllowFrom
				: null);
		if (groupSenderAllow && !groupSenderAllow.includes(openId)) {
			return { allowed: false, reason: "sender not allowed in this group" };
		}
		return { allowed: true, tier };
	}

	/** approve a pairing code from the CLI. Returns the bound open_id or null. */
	approvePairing(code: string): string | null {
		return this.pairing.approve(code, this.cfg.pairingTtlSeconds);
	}
	listPendingPairings(): Array<{ code: string; openId: string }> {
		return this.pairing.pending();
	}

	/** admin tier: full command access. user tier: restricted command set. */
	tier(openId: string): "admin" | "user" {
		if (this.cfg.adminAllowFrom.length === 0) return "admin"; // no split configured
		return this.cfg.adminAllowFrom.includes(openId) ? "admin" : "user";
	}

	/** True if a user-tier sender may run a given slash command. */
	userMayRunCommand(openId: string, command: string): boolean {
		const tier = this.tier(openId);
		if (tier === "admin") return true;
		const alwaysAllowed = ["help", "whoami"];
		return (
			alwaysAllowed.includes(command) || this.cfg.userAllowedCommands.includes(command)
		);
	}

	/** Resolve requireMention honoring per-group overrides and the "open" default. */
	private effectiveRequireMention(chatId: string): boolean {
		const grp = this.cfg.groups[chatId];
		if (grp?.requireMention !== undefined) return grp.requireMention;
		if (this.cfg.groupPolicy === "open") {
			return this.cfg.requireMention; // user may force true; default false
		}
		return this.cfg.requireMention;
	}

	close(): void {
		this.pairing.close();
	}
}
