import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/** Load .env into process.env (Bun has no built-in dotenv; we do the minimum). */
function loadEnv(path: string): void {
	if (!existsSync(path)) return;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq < 0) continue;
		const key = trimmed.slice(0, eq).trim();
		let val = trimmed.slice(eq + 1).trim();
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		if (val !== "" && process.env[key] === undefined) {
			process.env[key] = val;
		}
	}
}

loadEnv(resolve(import.meta.dirname, "..", ".env"));

export type BridgeConfig = {
	appId: string;
	appSecret: string;
	allowedOpenIds: Set<string>;
	ompCwd: string;
	ompModel: string | undefined;
	larkInternational: boolean;
	/** "https://open.feishu.cn" or "https://open.larksuite.com". */
	domain: string;
};

export function loadBridgeConfig(): BridgeConfig {
	const env = process.env;
	const appId = (env.FEISHU_APP_ID ?? "").trim();
	const appSecret = (env.FEISHU_APP_SECRET ?? "").trim();
	const larkInternational = (env.FEISHU_LARK_INTERNATIONAL ?? "").trim() === "1";
	return {
		appId,
		appSecret,
		allowedOpenIds: new Set(
			(env.FEISHU_ALLOWED_OPEN_IDS ?? "")
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean),
		),
		ompCwd: (env.OMP_CWD ?? resolve(import.meta.dirname, "..")).trim(),
		ompModel: (env.OMP_MODEL ?? "").trim() || undefined,
		larkInternational,
		domain: larkInternational
			? "https://open.larksuite.com"
			: "https://open.feishu.cn",
	};
}

/** True when we already have app credentials and can start the bridge. */
export function hasCredentials(cfg: BridgeConfig): boolean {
	return cfg.appId !== "" && cfg.appSecret !== "";
}
