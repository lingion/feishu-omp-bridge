import {
	createAgentSession,
	discoverAuthStorage,
	ModelRegistry,
	SessionManager,
	type AgentSession,
} from "@oh-my-pi/pi-coding-agent";

export type OmpOptions = {
	cwd: string;
	/** Default model pattern; per-chat overrides take precedence. */
	modelPattern: string | undefined;
};

/** A live omp session, plus its persisted file + optional name. */
export type ManagedSession = {
	chatId: string;
	session: AgentSession;
	sessionFile: string;
	name?: string;
};

/** Named-session record (for /sessions, /resume). */
export type NamedSession = { id: string; name: string };

/** Shared auth + model registry, created once for the process. */
async function bootstrap() {
	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	await modelRegistry.refresh();
	return { authStorage, modelRegistry };
}

const shared = bootstrap();

export class OmpSessionManager {
	private readonly options: OmpOptions;
	/** sessionKey → live session. sessionKey encodes chat or group-scope rules. */
	private readonly sessions = new Map<string, AgentSession>();
	/** Per-sessionKey model override (from /model). */
	private readonly modelOverrides = new Map<string, string>();

	constructor(options: OmpOptions) {
		this.options = options;
	}

	/** Create a fresh omp session under a given scope key. */
	async create(scopeKey: string): Promise<ManagedSession> {
		const { authStorage, modelRegistry } = await shared;
		const sessionManager = SessionManager.create(this.options.cwd);
		const { session } = await createAgentSession({
			agentId: `feishu-${scopeKey}`,
			agentDisplayName: `feishu-${scopeKey}`,
			cwd: this.options.cwd,
			authStorage,
			modelRegistry,
			sessionManager,
			modelPattern: this.modelOverrides.get(scopeKey) ?? this.options.modelPattern,
			autoApprove: true,
		});
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("omp session did not persist a session file");
		this.sessions.set(scopeKey, session);
		return { chatId: scopeKey, session, sessionFile };
	}

	/** Resume a previously persisted session from its .jsonl file. */
	async resume(scopeKey: string, sessionFile: string): Promise<ManagedSession> {
		const existing = this.sessions.get(scopeKey);
		if (existing) return { chatId: scopeKey, session: existing, sessionFile };
		const { authStorage, modelRegistry } = await shared;
		const sessionManager = await SessionManager.open(sessionFile);
		const { session } = await createAgentSession({
			agentId: `feishu-${scopeKey}`,
			agentDisplayName: `feishu-${scopeKey}`,
			cwd: this.options.cwd,
			authStorage,
			modelRegistry,
			sessionManager,
			modelPattern: this.modelOverrides.get(scopeKey) ?? this.options.modelPattern,
			autoApprove: true,
		});
		this.sessions.set(scopeKey, session);
		return { chatId: scopeKey, session, sessionFile };
	}

	/** Send a prompt, optionally with images, streaming text deltas to onText. */
	async prompt(
		scopeKey: string,
		text: string,
		onText: (delta: string) => void,
		images?: Array<{ data: string; mimeType: string }>,
	): Promise<string> {
		const session = this.sessions.get(scopeKey);
		if (!session) throw new Error(`no active omp session for ${scopeKey}`);
		let full = "";
		const unsubscribe = session.subscribe((event) => {
			if (
				event.type === "message_update" &&
				event.assistantMessageEvent.type === "text_delta"
			) {
				const delta = event.assistantMessageEvent.delta;
				full += delta;
				onText(delta);
			}
	});
	try {
		const imagesParam =
			images && images.length > 0
				? images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }))
				: undefined;
		await session.prompt(text, imagesParam ? { images: imagesParam } : undefined);
	} finally {
		unsubscribe();
	}
	return full;
	}

	/** Per-scope model override (set/clear by /model). Affects next create/resume. */
	setModel(scopeKey: string, model: string | undefined): void {
		if (model) this.modelOverrides.set(scopeKey, model);
		else this.modelOverrides.delete(scopeKey);
	}
	getModel(scopeKey: string): string | undefined {
		return this.modelOverrides.get(scopeKey) ?? this.options.modelPattern;
	}

	/** Dispose one scope's session (keeps its persisted file for later resume). */
	async dispose(scopeKey: string): Promise<void> {
		const session = this.sessions.get(scopeKey);
		if (!session) return;
		this.sessions.delete(scopeKey);
		session.beginDispose();
		await session.dispose();
	}

	/** Abort the in-progress turn for a chat (Hermes /stop). */
	async abort(scopeKey: string): Promise<boolean> {
		const session = this.sessions.get(scopeKey);
		if (!session) return false;
		await session.abort();
		return true;
	}

	/** Context-usage snapshot for /usage (tokens / context window). */
	async getContextUsage(scopeKey: string): Promise<string> {
		const session = this.sessions.get(scopeKey);
		if (!session) return "no active session";
		const usage = await session.getContextUsage();
		return JSON.stringify(usage);
	}

	/** List persisted omp sessions for this bridge's cwd (Hermes /sessions). */
	async listNamed(_scopeKey: string): Promise<NamedSession[]> {
		const infos = await SessionManager.list(this.options.cwd);
		return infos
			.slice(0, 20)
			.map((s) => ({ id: s.id, name: s.title ?? s.id }));
	}

	/** Resume a named session by title/id. */
	async resumeNamed(scopeKey: string, name: string): Promise<boolean> {
		const infos = await SessionManager.list(this.options.cwd);
		const match = infos.find((s) => s.title === name || s.id === name);
		if (!match) return false;
		await this.resume(scopeKey, match.path);
		return true;
	}

	/** Tear down every active session. */
	async disposeAll(): Promise<void> {
		await Promise.all(Array.from(this.sessions.keys()).map((k) => this.dispose(k)));
	}
}
