/**
 * Configuration types for the Feishu/Lark channel, aligned with OpenClaw's
 * `channels.feishu.*` shape (see docs.openclaw.ai/channels/feishu).
 *
 * Loaded from feishu-bridge.json5 by {@link loadConfig}. Missing keys fall
 * back to the defaults documented below; validation runs after the merge.
 */

export type DmPolicy = "pairing" | "allowlist" | "open";
export type GroupPolicy = "open" | "allowlist" | "disabled";
export type GroupSessionScope =
	| "group"
	| "group_sender"
	| "group_topic"
	| "group_topic_sender";
export type ReactionNotifications = "off" | "own" | "all";
export type RenderMode = "auto" | "raw" | "card";
export type StreamingMode = "partial" | "off";
export type ChunkMode = "length" | "newline";

/** Per-group overrides; explicit chat_id keys also admit a group in allowlist mode. */
export type GroupOverrides = Record<
	string,
	{
		enabled?: boolean;
		requireMention?: boolean;
		allowFrom?: string[];
	}
>;

/** Feishu workspace tool gates. `perm` defaults off (sensitive). */
export type ToolsConfig = {
	doc?: boolean;
	chat?: boolean;
	wiki?: boolean;
	drive?: boolean;
	perm?: boolean;
	scopes?: boolean;
	bitable?: boolean;
};

/** Optional TTS voice config for outbound voice replies (provider-keyed). */
export type TtsConfig = {
	providers?: Record<string, Record<string, unknown>>;
};

/** Named Feishu app accounts; inherits top-level keys, overrides deep-merge. */
export type AccountConfig = {
	appId: string;
	appSecret: string;
	name?: string;
	domain?: "feishu" | "lark";
	enabled?: boolean;
	tts?: TtsConfig;
	tools?: ToolsConfig;
};

export type FeishuConfig = {
	enabled: boolean;
	appId: string;
	appSecret: string;
	domain: "feishu" | "lark";
	connectionMode: "websocket" | "webhook";
	defaultAccount: string;

	// Access control
	dmPolicy: DmPolicy;
	allowFrom: string[];
	groupPolicy: GroupPolicy;
	groupAllowFrom: string[];
	groupSenderAllowFrom: string[];
	requireMention: boolean;
	allowBots: boolean;
	groups: GroupOverrides;

	// Sessions
	groupSessionScope: GroupSessionScope;
	replyInThread: "disabled" | "enabled";
	ompCwd: string;
	ompModel: string | undefined;
	defaultModel: string | undefined;

	// Routing overrides keyed by chat_id / thread id.
	channelOverrides: Record<
		string,
		{ model?: string; systemPrompt?: string }
	>;

	// Notifications + rendering
	reactionNotifications: ReactionNotifications;
	renderMode: RenderMode;
	streaming: { mode: StreamingMode; chunkMode: ChunkMode };
	textChunkLimit: number;
	mediaMaxMb: number;
	typingIndicator: boolean;
	resolveSenderNames: boolean;
	adminAllowFrom: string[];
	userAllowedCommands: string[];

	// Streaming cadence + durability knobs
	streamIntervalMs: number;
	deliveryLedger: boolean;
	deliveryLedgerPath: string | undefined;

	// Workspace tools
	tools: ToolsConfig;

	// Named accounts
	accounts: Record<string, AccountConfig>;

	// Pairing
	pairingTtlSeconds: number;

	// Persistence
	dataDir: string;
};

/** Normalized after validation; resolved booleans, absolute paths, domain URLs. */
export type ResolvedConfig = FeishuConfig & {
	domainUrl: string;
	pairingDbPath: string;
	sessionDbPath: string;
	ledgerDbPath: string;
};
