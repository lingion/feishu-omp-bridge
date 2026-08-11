import {
	createAgentSession,
	discoverAuthStorage,
	ModelRegistry,
	SessionManager,
	type AgentSession,
} from "@oh-my-pi/pi-coding-agent";

export type OmpOptions = {
	cwd: string;
	modelPattern: string | undefined;
};

/** A live omp session bound to one Feishu chat, plus its persisted file. */
export type ManagedSession = {
	chatId: string;
	session: AgentSession;
	sessionFile: string;
};

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
	private readonly sessions = new Map<string, AgentSession>();

	constructor(options: OmpOptions) {
		this.options = options;
	}

	/** Create a fresh omp session for a chat, returning the persisted file path. */
	async create(chatId: string): Promise<ManagedSession> {
		const { authStorage, modelRegistry } = await shared;
		const sessionManager = SessionManager.create(this.options.cwd);
		const { session } = await createAgentSession({
			agentId: `feishu-${chatId}`,
			agentDisplayName: `feishu-${chatId}`,
			cwd: this.options.cwd,
			authStorage,
			modelRegistry,
			sessionManager,
			modelPattern: this.options.modelPattern,
			// A headless bridge has no human at the terminal to approve tool calls.
			// Auto-approve keeps the agent unblocked; tighten if you want manual gates.
			autoApprove: true,
		});
		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("omp session did not persist a session file");
		this.sessions.set(chatId, session);
		return { chatId, session, sessionFile };
	}

	/** Resume a previously persisted session from its .jsonl file. */
	async resume(chatId: string, sessionFile: string): Promise<ManagedSession> {
		const existing = this.sessions.get(chatId);
		if (existing) return { chatId, session: existing, sessionFile };
		const { authStorage, modelRegistry } = await shared;
		const sessionManager = await SessionManager.open(sessionFile);
		const { session } = await createAgentSession({
			agentId: `feishu-${chatId}`,
			agentDisplayName: `feishu-${chatId}`,
			cwd: this.options.cwd,
			authStorage,
			modelRegistry,
			sessionManager,
			modelPattern: this.options.modelPattern,
			autoApprove: true,
		});
		this.sessions.set(chatId, session);
		return { chatId, session, sessionFile };
	}

	/** Send a prompt and stream assistant text deltas to `onText`. */
	async prompt(
		chatId: string,
		text: string,
		onText: (delta: string) => void,
	): Promise<string> {
		const session = this.sessions.get(chatId);
		if (!session) throw new Error(`no active omp session for chat ${chatId}`);
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
			await session.prompt(text);
		} finally {
			unsubscribe();
		}
		return full;
	}

	/** Dispose one chat's session (keeps its persisted file for later resume). */
	async dispose(chatId: string): Promise<void> {
		const session = this.sessions.get(chatId);
		if (!session) return;
		this.sessions.delete(chatId);
		session.beginDispose();
		await session.dispose();
	}

	/** Tear down every active session. */
	async disposeAll(): Promise<void> {
		await Promise.all(
			Array.from(this.sessions.keys()).map((id) => this.dispose(id)),
		);
	}
}
