import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Generate a launchd plist for the bridge and (un)install it. */
export const LAUNCH_LABEL = "ai.feishu-omp.bridge";
const AGENTS_DIR = join(homedir(), "Library/LaunchAgents");
const PLIST_PATH = join(AGENTS_DIR, `${LAUNCH_LABEL}.plist`);

/** Build the plist XML. Keeps PATH from the installing shell so bun is found. */
export function buildPlist(opts: {
	bunPath: string;
	scriptPath: string;
	cwd: string;
}): string {
	const { bunPath, scriptPath, cwd } = opts;
	// KeepAlive so the bridge restarts if it crashes; RunAtLoad to start at login.
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>run</string>
    <string>${scriptPath}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${cwd}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}</string>
    <key>HOME</key>
    <string>${homedir()}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${cwd}/bridge.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${cwd}/bridge.stderr.log</string>
</dict>
</plist>
`;
}

/** UID for the launchd gui/ domain; errors clearly when getuid is unavailable. */
function uid(): number {
	const u = process.getuid?.();
	if (u === undefined) throw new Error("launchd service management requires macOS (POSIX getuid)");
	return u;
}

/** Install the plist, load it, return the path. */
export function install(bunPath: string, scriptPath: string, cwd: string): string {
	mkdirSync(AGENTS_DIR, { recursive: true });
	writeFileSync(PLIST_PATH, buildPlist({ bunPath, scriptPath, cwd }));
	// launchctl bootstrap (modern API, macOS 11+).
	Bun.spawn(["launchctl", "bootstrap", `gui/${uid()}`, PLIST_PATH], {
		stdout: "inherit",
		stderr: "inherit",
	});
	return PLIST_PATH;
}

/** Unload + remove the plist. */
export function uninstall(): void {
	if (!existsSync(PLIST_PATH)) return;
	Bun.spawn(["launchctl", "bootout", `gui/${uid()}/${LAUNCH_LABEL}`], {
		stdout: "inherit",
		stderr: "inherit",
	});
	rmSync(PLIST_PATH, { force: true });
}

export function status(): { installed: boolean; path: string } {
	return { installed: existsSync(PLIST_PATH), path: PLIST_PATH };
}
