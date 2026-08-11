import JSON5 from "json5";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import type { FeishuConfig, ResolvedConfig } from "./config-types.ts";

const CONFIG_PATH = resolve(import.meta.dirname, "..", "feishu-bridge.json5");
const ENV_PATH = resolve(import.meta.dirname, "..", ".env");

/** Resolve ~ and relative paths against home. */
function expandPath(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return resolve(p);
}

/** Apply env-var fallbacks for credentials so .env stays a valid credential source. */
function applyEnvFallbacks(raw: FeishuConfig): void {
	const env = loadEnvLines(ENV_PATH);
	if (!raw.appId && env.FEISHU_APP_ID) raw.appId = env.FEISHU_APP_ID;
	if (!raw.appSecret && env.FEISHU_APP_SECRET) raw.appSecret = env.FEISHU_APP_SECRET;
	if (env.FEISHU_ALLOWED_OPEN_IDS && raw.allowFrom.length === 0) {
		raw.allowFrom = env.FEISHU_ALLOWED_OPEN_IDS.split(",").map((s) => s.trim()).filter(Boolean);
	}
	if (env.OMP_CWD && raw.ompCwd === defaults.ompCwd) raw.ompCwd = env.OMP_CWD;
	if (env.OMP_MODEL && !raw.ompModel) raw.ompModel = env.OMP_MODEL || undefined;
	if (env.FEISHU_LARK_INTERNATIONAL === "1" && raw.domain === "feishu") {
		raw.domain = "lark";
	}
}

/** Minimal .env reader (shared with config.ts legacy path). */
function loadEnvLines(path: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!existsSync(path)) return out;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const t = line.trim();
		if (!t || t.startsWith("#")) continue;
		const eq = t.indexOf("=");
		if (eq < 0) continue;
		out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
	}
	return out;
}

/** Deep-merge a partial user config over defaults. Arrays are replaced, not concatenated. */
function deepMerge<T>(base: T, override: Partial<T>): T {
	if (override === null || override === undefined) return base;
	if (typeof base !== "object" || base === null) return override as T;
	if (Array.isArray(base)) return (override as unknown as T) ?? base;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
		out[k] =
			v !== null && typeof v === "object" && !Array.isArray(v)
				? deepMerge((out[k] as Record<string, unknown>) ?? {}, v as Record<string, unknown>)
				: v;
	}
	return out as T;
}

/** Canonical defaults; mirrors OpenClaw channels.feishu defaults. */
const defaults: FeishuConfig = {
	enabled: true,
	appId: "",
	appSecret: "",
	domain: "feishu",
	connectionMode: "websocket",
	defaultAccount: "default",
	dmPolicy: "allowlist",
	allowFrom: [],
	groupPolicy: "allowlist",
	groupAllowFrom: [],
	groupSenderAllowFrom: [],
	requireMention: true,
	allowBots: false,
	groups: {},
	groupSessionScope: "group",
	replyInThread: "disabled",
	ompCwd: "~/.feishu-omp-workspace",
	ompModel: undefined,
	defaultModel: undefined,
	channelOverrides: {},
	reactionNotifications: "own",
	renderMode: "auto",
	streaming: { mode: "partial", chunkMode: "length" },
	textChunkLimit: 4000,
	mediaMaxMb: 30,
	typingIndicator: true,
	resolveSenderNames: true,
	adminAllowFrom: [],
	userAllowedCommands: ["help", "status", "model"],
	streamIntervalMs: 700,
	deliveryLedger: true,
	deliveryLedgerPath: undefined,
	tools: {
		doc: true,
		chat: true,
		wiki: true,
		drive: true,
		perm: false,
		scopes: true,
		bitable: true,
	},
	accounts: {},
	pairingTtlSeconds: 3600,
	dataDir: "~/.feishu-omp-bridge",
};

/** Validate the merged config; throw with a precise message on bad shapes. */
function validate(cfg: FeishuConfig): void {
	if (!cfg.appId || !cfg.appSecret) {
		throw new Error(
			"feishu-bridge.json5: appId and appSecret are required. Run `bun run register-app` or fill .env.",
		);
	}
	if (cfg.dmPolicy === "open" && !(cfg.allowFrom.length === 0 || cfg.allowFrom.includes("*"))) {
		throw new Error('dmPolicy "open" requires allowFrom: ["*"] (or empty + explicit entries)');
	}
	if (cfg.dmPolicy === "allowlist" && cfg.allowFrom.length === 0) {
		throw new Error('dmPolicy "allowlist" requires at least one open_id in allowFrom');
	}
	if (cfg.groupPolicy === "disabled" && Object.keys(cfg.groups).length > 0) {
		// Not fatal — explicit groups cannot override disabled; warn via stderr.
		console.error("[config] warning: groupPolicy is disabled; per-group entries are ignored");
	}
	if (!["feishu", "lark"].includes(cfg.domain)) {
		throw new Error(`domain must be "feishu" or "lark", got "${cfg.domain}"`);
	}
}

/** Load, merge, validate, and resolve paths. Returns a fully usable config. */
export function loadConfig(path: string = CONFIG_PATH): ResolvedConfig {
	let raw: FeishuConfig;
	if (existsSync(path)) {
		raw = deepMerge(defaults, JSON5.parse(readFileSync(path, "utf8")) as Partial<FeishuConfig>);
	} else {
		// No json5 yet — fall back to defaults + env. Allows the bridge to start
		// from a .env-only setup until the user runs the config wizard.
		raw = structuredClone(defaults);
	}
	applyEnvFallbacks(raw);
	validate(raw);

	const dataDir = expandPath(raw.dataDir);
	const resolved: ResolvedConfig = {
		...raw,
		ompCwd: expandPath(raw.ompCwd),
		dataDir,
		domainUrl:
			raw.domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn",
		pairingDbPath: join(dataDir, "pairing.db"),
		sessionDbPath: join(dataDir, "sessions.db"),
		ledgerDbPath: raw.deliveryLedgerPath ? expandPath(raw.deliveryLedgerPath) : join(dataDir, "ledger.db"),
	};
	mkdirSync(dataDir, { recursive: true });
	mkdirSync(resolved.ompCwd, { recursive: true });
	return resolved;
}
