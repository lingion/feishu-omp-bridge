import type { ResolvedConfig } from "./config-types.ts";
import type { AccessControl } from "./access.ts";
import type { OmpSessionManager } from "./omp.ts";

/** A slash command handler. Returns text to send back, or void for side effects. */
export type CommandContext = {
	chatId: string;
	openId: string;
	args: string;
	reply: (text: string) => Promise<void>;
	omp: OmpSessionManager;
	access: AccessControl;
};

export type Command = {
	name: string;
	description: string;
	/** admin-only commands are gated to the admin tier; others honor userAllowedCommands. */
	adminOnly?: boolean;
	execute: (ctx: CommandContext) => Promise<string | void>;
};

/** Per-chat persisted overrides (model) live in the session store; injected here. */
export type OverrideStore = {
	getModel(chatId: string): string | undefined;
	setModel(chatId: string, model: string | undefined): void;
};

export class CommandRegistry {
	private readonly commands = new Map<string, Command>();
	private readonly cfg: ResolvedConfig;
	private readonly overrides: OverrideStore;

	constructor(cfg: ResolvedConfig, overrides: OverrideStore) {
		this.cfg = cfg;
		this.overrides = overrides;
		this.registerBuiltins();
	}

	/** Route a "/name args" line. Returns true if handled (caller stops normal flow). */
	async route(
		line: string,
		ctx: CommandContext,
	): Promise<{ handled: boolean; output?: string }> {
		const m = line.match(/^\/(\w+)(?:\s+(.*))?$/s);
		if (!m) return { handled: false };
		const name = m[1].toLowerCase();
		const args = (m[2] ?? "").trim();
		const cmd = this.commands.get(name);
		if (!cmd) return { handled: true, output: `Unknown command: /${name}. Try /help.` };

		// Permission gate.
		if (cmd.adminOnly && ctx.access.tier(ctx.openId) !== "admin") {
			return { handled: true, output: `/${name} is admin-only.` };
		}
		if (!ctx.access.userMayRunCommand(ctx.openId, name)) {
			return {
				handled: true,
				output: `/${name} is not available to your tier. /whoami shows your access.`,
			};
		}
		const out = await cmd.execute({ ...ctx, args });
		return { handled: true, output: out ?? undefined };
	}

	/** List of {name, description} for /help, respecting tier visibility. */
	helpFor(openId: string): Array<{ name: string; description: string }> {
		return Array.from(this.commands.values())
			.filter((c) => ctxCanSee(c, this.cfg, openId))
			.map((c) => ({ name: c.name, description: c.description }));
	}

	private register(cmd: Command): void {
		this.commands.set(cmd.name, cmd);
	}

	private registerBuiltins(): void {
		this.register({
			name: "help",
			description: "Show available commands",
			execute: (ctx) => {
				const cmds = this.helpFor(ctx.openId)
					.map((c) => `  /${c.name} — ${c.description}`)
					.join("\n");
				return Promise.resolve(`omp-bridge commands:\n${cmds}`);
			},
		});

		this.register({
			name: "whoami",
			description: "Show your tier and command access",
			execute: (ctx) => {
				const tier = ctx.access.tier(ctx.openId);
				const allowed = this.helpFor(ctx.openId)
					.map((c) => `/${c.name}`)
					.join(", ");
				return Promise.resolve(
					`open_id: ${ctx.openId}\ntier: ${tier}\ncommands: ${allowed}`,
				);
			},
		});

		this.register({
			name: "status",
			description: "Show bridge + current chat status",
			execute: (ctx) => {
				const model =
					this.overrides.getModel(ctx.chatId) ?? this.cfg.ompModel ?? "(omp default)";
				return Promise.resolve(
					`domain: ${this.cfg.domain}\ncmpCwd: ${this.cfg.ompCwd}\n` +
						`model: ${model}\ndmPolicy: ${this.cfg.dmPolicy}\n` +
						`groupPolicy: ${this.cfg.groupPolicy}`,
				);
			},
		});

		this.register({
			name: "reset",
			description: "Reset this chat's omp session",
			execute: async (ctx) => {
				await ctx.omp.dispose(ctx.chatId);
				return "Session reset. Next message starts fresh.";
			},
		});

		this.register({
			name: "model",
			description: "Show or set the model for this chat (admin: /model <name>)",
			execute: (ctx) => {
				if (!ctx.args) {
					const m =
						this.overrides.getModel(ctx.chatId) ?? this.cfg.ompModel ?? "(omp default)";
					return Promise.resolve(`Current model: ${m}`);
				}
				if (ctx.access.tier(ctx.openId) !== "admin") {
					return Promise.resolve("Only admins can change the model.");
				}
				this.overrides.setModel(ctx.chatId, ctx.args);
				return Promise.resolve(`Model for this chat set to: ${ctx.args}`);
			},
		});

		this.register({
			name: "sessions",
			description: "List named omp sessions for this chat",
			adminOnly: true,
			execute: async (ctx) => {
				const list = await ctx.omp.listNamed(ctx.chatId);
				if (list.length === 0) return "No named sessions.";
				return list.map((s) => `  ${s.name} (${s.id})`).join("\n");
			},
		});

		this.register({
			name: "resume",
			description: "Resume a named session: /resume <name>",
			adminOnly: true,
			execute: async (ctx) => {
				if (!ctx.args) return "Usage: /resume <name>";
				const ok = await ctx.omp.resumeNamed(ctx.chatId, ctx.args);
				return ok ? `Resumed session: ${ctx.args}` : `No session named "${ctx.args}".`;
			},
		});
	}
}

/** True if a user of this tier is allowed to see the command in /help. */
function ctxCanSee(
	cmd: Command,
	cfg: ResolvedConfig,
	_openId: string,
): boolean {
	if (cmd.adminOnly) return true; // shown but gated; non-admins get the gate message
	if (cfg.adminAllowFrom.length === 0) return true; // no split → all visible
	return ["help", "whoami", ...cfg.userAllowedCommands].includes(cmd.name);
}
