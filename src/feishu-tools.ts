import type { ResolvedConfig } from "./config-types.ts";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import JSON5 from "json5";

/**
 * Feishu workspace tools.
 *
 * Rather than re-implementing Feishu's doc/wiki/drive/bitable APIs, we register
 * the official `@larksuiteoapi/lark-mcp` MCP server with omp sessions so the
 * agent gains Feishu tools through the standard MCP surface. This mirrors
 * OpenClaw's `feishu_doc` / `feishu_drive` / `feishu_wiki` / `feishu_bitable`
 * tool families, gated by the same `tools.*` config flags.
 *
 * The bridge writes a per-process MCP config snippet that omp discovers, so
 * every session created after {@link install} picks up the Feishu tools whose
 * families the operator enabled.
 */

/** Preset toolsets from lark-mcp, mapped from our config gate flags. */
const FAMILY_TO_PRESET: Record<string, string> = {
	doc: "preset.doc.default",
	wiki: "preset.doc.default", // wiki ships inside the doc preset
	drive: "preset.doc.default",
	bitable: "preset.base.default",
	chat: "preset.im.default",
};

/** Scopes the operator must grant in the Feishu app console for each family. */
export const SCOPES_BY_FAMILY: Record<string, string[]> = {
	doc: ["docx:document", "docx:document:readonly"],
	wiki: ["wiki:wiki", "wiki:wiki:readonly"],
	drive: ["drive:drive", "drive:drive.metadata:readonly"],
	bitable: ["bitable:app", "bitable:app:readonly"],
	chat: ["im:chat", "im:chat:readonly", "im:message:readonly"],
	perm: ["drive:permission"],
	scopes: [],
};

/** Build the `-t` toolset argument for lark-mcp from enabled families. */
export function buildToolsetArg(cfg: ResolvedConfig): string {
	const enabled = Object.entries(cfg.tools)
		.filter(([k, v]) => v === true && FAMILY_TO_PRESET[k])
		.map(([k]) => FAMILY_TO_PRESET[k]!);
	// Dedupe (doc/wiki/drive share preset.doc.default) and join.
	return Array.from(new Set(enabled)).join(",");
}

/** Human-readable scope guidance printed during install/onboarding. */
export function scopesGuidance(cfg: ResolvedConfig): string {
	const lines: string[] = [];
	for (const [family, on] of Object.entries(cfg.tools)) {
		if (on !== true) continue;
		const scopes = SCOPES_BY_FAMILY[family];
		if (scopes && scopes.length > 0) {
			lines.push(`  ${family}: ${scopes.join(", ")}`);
		}
	}
	if (lines.length === 0) return "No Feishu workspace tools enabled.";
	return `Grant these scopes in the Feishu app console for the enabled tool families:\n${lines.join("\n")}`;
}
/** True if any Feishu workspace tool family is enabled. */
export function anyToolsEnabled(cfg: ResolvedConfig): boolean {
	return Object.values(cfg.tools).some((v) => v === true);
}

/** Path to omp's user-level MCP config (created if missing). */
function ompMcpJsonPath(): string {
	return join(homedir(), ".omp/agent/mcp.json");
}

/**
 * Register `@larksuiteoapi/lark-mcp` into omp's user mcp.json so every omp
 * session this bridge creates gains the enabled Feishu tool families (doc /
 * wiki / drive / bitable / chat). Idempotent: re-runs just update the entry.
 *
 * This is the real wiring — without it the bridge only logs the intended
 * toolset and omp has no Feishu tools at all.
 */
export function installLarkMcp(cfg: ResolvedConfig): void {
	if (!anyToolsEnabled(cfg)) return;
	const toolset = buildToolsetArg(cfg);
	if (!toolset) return;
	const path = ompMcpJsonPath();
	let doc: { mcpServers?: Record<string, unknown> } = {};
	if (existsSync(path)) {
		try {
			doc = JSON5.parse(readFileSync(path, "utf8")) as typeof doc;
		} catch {
			doc = {};
		}
	}
	doc.mcpServers ??= {};
	(doc.mcpServers as Record<string, unknown>)["lark"] = {
		command: "npx",
		args: [
			"-y",
			"@larksuiteoapi/lark-mcp",
			"mcp",
			"-a",
			cfg.appId,
			"-s",
			cfg.appSecret,
			"-d",
			cfg.domainUrl,
			"-l",
			"zh",
			"-t",
			toolset,
		],
	};
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(doc, null, 2));
	console.info(`[feishu-tools] lark-mcp registered in ${path} (toolset: ${toolset})`);
}
