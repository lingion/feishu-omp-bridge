<p align="center">
  <a href="https://github.com/lingion/feishu-omp-bridge"><img src="https://img.shields.io/github/stars/lingion/feishu-omp-bridge?style=for-the-badge&logo=github&color=FFD700" alt="Stars"></a>
  <a href="https://github.com/lingion/feishu-omp-bridge/network/members"><img src="https://img.shields.io/github/forks/lingion/feishu-omp-bridge?style=for-the-badge&logo=github&color=8B5CF6" alt="Forks"></a>
  <a href="https://github.com/lingion/feishu-omp-bridge/issues"><img src="https://img.shields.io/github/issues/lingion/feishu-omp-bridge?style=for-the-badge&logo=github&color=EF4444" alt="Issues"></a>
  <a href="https://github.com/lingion/feishu-omp-bridge/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge" alt="License"></a>
  <br>
  <a href="https://bun.sh/"><img src="https://img.shields.io/badge/runtime-Bun-FFB714?style=flat-square&logo=bun&logoColor=white" alt="Bun"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/lang-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://open.feishu.cn/"><img src="https://img.shields.io/badge/platform-Feishu%2FLark-3370FF?style=flat-square" alt="Feishu"></a>
  <a href="https://github.com/can1357/oh-my-pi"><img src="https://img.shields.io/badge/backend-omp-6366F1?style=flat-square" alt="omp"></a>
  <a href="https://github.com/lingion/feishu-omp-bridge/commits/main"><img src="https://img.shields.io/github/last-commit/lingion/feishu-omp-bridge?style=flat-square" alt="Last commit"></a>
</p>

# feishu-omp-bridge

> A Feishu/Lark <-> omp (Oh My Pi) bidirectional messaging bridge.
> DM or @mention a bot → drives an omp coding agent → streams the reply back as an interactive Feishu card.

[English](README.md) | [中文说明](README-zh-CN.md)

Current version: **0.1.0** · Last verified: 2026-08-11 · Live-tested against a real Feishu self-built app

```
Feishu/Lark chat
      |
      v
WSClient long-connection (no public URL needed)
      |
      v
bridge process (Bun)
      |
      v
omp createAgentSession SDK → omp coding agent
      |
      v
streaming card reply back to Feishu
```

The bridge is **not** a 1:1 port of OpenClaw's `@openclaw/feishu` plugin or
Hermes Agent's feishu platform (both ~8,000 lines). It is a smaller channel
(2,706 lines of TypeScript) that covers the core messaging surface — and every
capability below was cross-verified against the **installed source** of both
reference plugins on the development machine.

## What Works

| Capability | Reference |
|---|---|
| Bot DMs + group chats (WSClient long-conn) | OpenClaw / Hermes |
| Streaming card replies (debounced patch) | Hermes `flush` |
| Receive **images** → omp ImageAttachment | Hermes `_download_feishu_image` |
| Receive **.txt/.md** files — content inlined (<64 KiB) | Hermes `_maybe_extract_text_document` |
| Receive **binary** files — saved + placeholder + path for omp's `read` tool | Hermes saved-attachment model |
| Receive **audio/video/stickers** — saved + placeholder | Hermes `_handle_message_event_data` |
| Send **images/files/audio/video** — native bubbles | Hermes `send_image/file/voice/video` |
| Rich text **post** parse (inbound → text) + build (outbound, fenced code-block isolation) | Hermes `_build_markdown_post_rows` |
| Forwarded / merged-forward message parsing | Hermes `_normalize_merge_forward_message` |
| `dmPolicy`: allowlist / pairing / open | OpenClaw `dmPolicy` |
| `groupPolicy`: open / allowlist / disabled + requireMention + per-group overrides | OpenClaw `groupPolicy` |
| `groupSessionScope`: group / group_sender / group_topic / group_topic_sender | OpenClaw `groupSessionScope` |
| Precise @bot detection (hydrated bot open_id from /bot/v3/info) | Hermes `_mentions_self` |
| `replyInThread` — message.reply + topic thread creation | OpenClaw `replyInThread` |
| Admin/user command tier split | Hermes tier split |
| Per-chat serial lock (LRU) | Hermes `_get_chat_lock` |
| Card-action dedup | Hermes `_is_card_action_duplicate` |
| Slash commands: `/help`, `/whoami`, `/status`, `/reset`, `/model`, `/sessions`, `/resume`, `/stop`, `/usage` | Hermes command set |
| Per-chat persistent `/model` override (survives restart) | Hermes `/model` |
| Delivery ledger (at-least-once redelivery after crash) | Hermes `state.db` |
| Typing indicator (OK reaction) | Hermes `send_typing` |
| Bot-loop protection (ignore other bots by default) | OpenClaw `allowBots` |
| `resolveSenderNames` via `contact.v3.user.get` + TTL cache | Hermes `_resolve_sender_name_from_api` |
| Bot-added group greeting | OpenClaw |
| Events: bot added/removed, recall, read, drive comment, meeting invite | Hermes `_on_*` |
| Feishu workspace tools (doc/wiki/drive/bitable/chat via official lark-mcp MCP server) | OpenClaw `tools.*` |
| QR onboarding (`registerApp`) | Feishu SDK |
| JSON5 config (aligned `channels.feishu.*`) | OpenClaw config |
| launchd service install | Hermes gateway install |

## What Does NOT Work

Each gap is either an omp architecture limit or a deliberately-cut subsystem.

| Gap | Reason |
|---|---|
| Interactive approval buttons | omp approval is a synchronous policy — no blocking hook like Hermes `resolve_gateway_approval()` |
| Clarify / online prompt cards | Same omp limit — no blocking ask hook |
| Drive comment rule engine | ~1,800-line subsystem (Hermes `feishu_comment.py`) — not ported |
| Meeting auto-join | Needs `vc:meeting.bot.join:write` scope — not ported |
| Audio transcription (ASR) | No bundled ASR provider (Hermes/OpenClaw also require configured provider) |
| `/retry` / `/undo` | omp has no public session retry/undo API |
| `/sessions` / `/resume` content | Registry wired, list shows sessions — but resume-by-name is a stub |
| Multi-account | Config schema supports `accounts.*`; runtime uses default account only |

## Tested

### Live (real Feishu app, observed via logs)

| Test | Result |
|---|---|
| Text message → streaming card reply | ✓ |
| Image message → omp sees image | ✓ |
| `.txt` file → content inlined, omp read it | ✓ |
| `.pdf` file → saved + omp used `read` tool | ✓ |
| Slash commands (`/help`, `/status`, `/model`, `/reset`, `/whoami`, `/stop`, `/usage`) | ✓ |
| Multi-session persistence + resume across restart | ✓ |
| Access control (allowlist deny stranger) | ✓ |
| Group chat @bot detection + reply | ✓ |
| Bot-added group greeting | ✓ |
| Reaction typing indicator (OK emoji) | ✓ |

### Unit-verified

| Module | Check |
|---|---|
| `rich.ts` post parse/build | ✓ flattens post→text; code-fence isolation → 3 rows |
| `concurrency.ts` chat lock | ✓ same-chat serial A→B, different-chat concurrent |
| `concurrency.ts` card dedup | ✓ first=false, repeat=true |
| `rich.ts` forward/merge-forward parse | ✓ extracts sender+body correct |
| `tsc --noEmit` | ✓ zero errors |

### Not yet tested live

- Group message batching (batch window)
- Sticker inbound
- Drive-comment / meeting-invite event delivery
- Delivery-ledger redelivery after crash
- launchd service install on this machine

## Quick Start

```bash
# 1. Clone + install
git clone https://github.com/lingion/feishu-omp-bridge.git
cd feishu-omp-bridge
bun install   # China: --registry=https://registry.npmmirror.com

# 2. Create Feishu app (scan QR on phone)
bun run register-app

# 3. Add your open_id to .env
echo "FEISHU_ALLOWED_OPEN_IDS=ou_your_id" >> .env

# 4. Start
bun run start

# Optional: install as macOS launchd service (starts at login, auto-restart)
bun run service:install
```

`register-app` writes `FEISHU_APP_ID` / `FEISHU_APP_SECRET` to `.env`.

## Configuration

Copy `config.example.json5` to `feishu-bridge.json5` for the full schema.
`.env` is a credential fallback.

```json5
{
  domain: "feishu",  // or "lark" for international
  dmPolicy: "allowlist",
  allowFrom: ["ou_xxx"],
  groupPolicy: "allowlist",
  groupAllowFrom: ["oc_xxx"],
  requireMention: true,
  groupSessionScope: "group",
  ompCwd: "/Users/you/project",
  ompModel: null,     // pin a model, e.g. "anthropic/claude-sonnet-4"
  streaming: { mode: "partial", chunkMode: "length" },
  deliveryLedger: true,
  tools: { doc: true, chat: true, wiki: true, drive: true, bitable: true },
}
```

## Slash Commands

Send as plain text — Feishu has no native slash menus.

| Command | Description | Admin-only |
|---|---|---|
| `/help` | Available commands (tier-aware) | |
| `/whoami` | Your open_id + tier + commands | |
| `/status` | Bridge config: domain, ompCwd, model, policies | |
| `/reset` | Drop this chat's omp session | |
| `/model [name]` | Show or (admin) set the model for this chat | set |
| `/stop` | Abort the running omp turn | |
| `/usage` | Context/token usage stats | |
| `/sessions` | List persisted sessions | yes |
| `/resume <name>` | Resume a named session | yes |

## Operation

```bash
bun run start                # foreground
bun run service:install      # launchd (auto-start at login, restart on crash)
bun run service:uninstall
tail -f bridge.stderr.log    # live log
```

## Architecture (2,706 LOC)

| File | LOC | Responsibility |
|---|---|---|
| `src/index.ts` | 531 | Main bridge: WSClient inbound → access/commands/media → omp → streaming card |
| `src/media.ts` | 262 | Image/file/audio/video download + upload, downloadToPath, typing |
| `src/commands.ts` | 193 | Slash-command registry + tier-gated router |
| `src/omp.ts` | 174 | omp `createAgentSession` + resume + sendPrompt + model overrides |
| `src/access.ts` | 170 | DM/group policies, pairing codes, admin/user tiers |
| `src/config-loader.ts` | 158 | JSON5 defaults-merge + validation + path resolution |
| `src/rich.ts` | 153 | post parse/build, forward/merge-forward, share-chat |
| `src/config-types.ts` | 124 | Config type definitions |
| `src/feishu-tools.ts` | 116 | lark-mcp installation + scope guidance |
| `src/store.ts` | 104 | SQLite: chat→session map + per-chat model overrides |
| `src/ledger.ts` | 102 | At-least-once delivery ledger |
| `src/batcher.ts` | 101 | Per-chat message batching (coalesce rapid messages) |
| `src/service.ts` | 83 | launchd plist generator + install/uninstall |
| `src/events.ts` | 79 | Event handlers: bot added/removed, recall, read, drive comment, meeting |
| `src/onboard.ts` | 72 | QR onboarding (`registerApp`) |
| `src/config.ts` | 65 | Legacy env-based config (backwards compat) |
| `src/concurrency.ts` | 57 | Per-chat LRU lock + card-action dedup |
| `src/mentions.ts` | 52 | Bot identity hydrate + precise @bot detection |
| `src/sender.ts` | 38 | Sender name resolution via contact API + TTL cache |
| `src/scope.ts` | 36 | groupSessionScope keying + bot-loop detection |
| `src/types.ts` | 36 | `im.message.receive_v1` event payload type |

## Security

- `autoApprove: true` — headless bridge auto-approves omp tool calls. Keep `allowFrom` locked.
- `.env` (secrets), `*.db` (sessions/pairing/ledger), `node_modules/` are git-ignored.

## Cross-Verification Note

Every capability under "What Works" was checked against the **installed source**
of Hermes Agent (`~/.hermes/hermes-agent/plugins/platforms/feishu/adapter.py`,
8,167 lines) and OpenClaw (`/usr/local/lib/node_modules/openclaw/docs/channels/feishu.md`)
on this machine — not their marketing pages. Where a reference plugin does
something this bridge cannot, the reason is stated: either an omp architecture
limit (no blocking approval hook) or a cut subsystem.

## Maintained By

- **Lingion**: core bridge, feishu/lark adapter, omp integration

## License

MIT
