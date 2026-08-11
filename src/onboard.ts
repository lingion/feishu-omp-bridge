import * as lark from "@larksuiteoapi/node-sdk";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ENV_PATH = resolve(import.meta.dirname, "..", ".env");
const ENV_EXAMPLE = resolve(import.meta.dirname, "..", ".env.example");

/** Read current .env lines (creating from example if missing). */
function readEnvLines(): string[] {
	if (!existsSync(ENV_PATH)) {
		if (existsSync(ENV_EXAMPLE)) return readFileSync(ENV_EXAMPLE, "utf8").split("\n");
		return [];
	}
	return readFileSync(ENV_PATH, "utf8").split("\n");
}

/** Write an updated key back into .env, preserving everything else. */
function writeEnvKey(key: string, value: string): void {
	const lines = readEnvLines();
	let found = false;
	const next = lines.map((line) => {
		const trimmed = line.trim();
		if (trimmed.startsWith("#")) return line;
		const eq = trimmed.indexOf("=");
		if (eq < 0) return line;
		if (trimmed.slice(0, eq).trim() === key) {
			found = true;
			return `${key}=${value}`;
		}
		return line;
	});
	if (!found) next.push(`${key}=${value}`);
	writeFileSync(ENV_PATH, next.join("\n"));
}

async function main(): Promise<void> {
	console.log("Generating a Feishu QR code to create a self-built app...");
	console.log("Open the link on a phone with Feishu/Lark installed and approve.\n");

	const result = await lark.registerApp({
		// Robot ability is the minimal base; add the scopes/events the bridge needs.
		addons: {
			scopes: {
				tenant: ["im:message", "im:message:send_as_bot", "im:chat"],
			},
			events: { items: { tenant: ["im.message.receive_v1"] } },
		},
		createOnly: true,
		appPreset: { name: "omp-bridge" },
		onQRCodeReady(info) {
			console.log("Scan this URL (or open it in Feishu):");
			console.log(info.url);
			console.log(`\nExpires in ${info.expireIn}s.\n`);
		},
		onStatusChange(info) {
			console.log(`[status] ${info.status}`);
		},
	});

	writeEnvKey("FEISHU_APP_ID", result.client_id);
	writeEnvKey("FEISHU_APP_SECRET", result.client_secret);

	console.log("\nDone. Credentials written to .env:");
	console.log(`  FEISHU_APP_ID=${result.client_id}`);
	console.log(`  FEISHU_APP_SECRET=${result.client_secret}`);
	console.log("\nNext: add your open_id to FEISHU_ALLOWED_OPEN_IDS in .env, then `bun run start`.");
}

main().catch((err) => {
	console.error("registerApp failed:", err?.code ?? err);
	process.exit(1);
});
