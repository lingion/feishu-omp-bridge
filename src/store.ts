import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type ChatSessionMapping = {
	chatId: string;
	sessionFile: string;
	cwd: string;
	createdAt: string;
	updatedAt: string;
};

export class SessionStore {
	private readonly db: Database;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = new Database(path, { create: true });
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS chat_sessions (
				chat_id    TEXT PRIMARY KEY,
				session_file TEXT NOT NULL,
				cwd        TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
		`);
	}

	get(chatId: string): ChatSessionMapping | null {
		const row = this.db
			.prepare(
				"SELECT chat_id, session_file, cwd, created_at, updated_at FROM chat_sessions WHERE chat_id = ?",
			)
			.get(chatId) as
			| {
					chat_id: string;
					session_file: string;
					cwd: string;
					created_at: string;
					updated_at: string;
			  }
			| null;
		if (!row) return null;
		return {
			chatId: row.chat_id,
			sessionFile: row.session_file,
			cwd: row.cwd,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	upsert(mapping: ChatSessionMapping): void {
		this.db
			.prepare(
				`INSERT INTO chat_sessions (chat_id, session_file, cwd, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(chat_id) DO UPDATE SET
				   session_file = excluded.session_file,
				   cwd          = excluded.cwd,
				   updated_at   = excluded.updated_at`,
			)
			.run(
				mapping.chatId,
				mapping.sessionFile,
				mapping.cwd,
				mapping.createdAt,
				mapping.updatedAt,
			);
	}

	delete(chatId: string): void {
		this.db.prepare("DELETE FROM chat_sessions WHERE chat_id = ?").run(chatId);
	}

	close(): void {
		this.db.close();
	}
}
