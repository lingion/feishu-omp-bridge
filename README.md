# feishu-omp-bridge

Bidirectional bridge: chat with the **omp (Oh My Pi)** terminal agent from Feishu/Lark.
DM (or @mention in a group) a Feishu bot → it drives an omp session → the agent's
reply streams back into the chat. Each Feishu chat gets its own persistent omp session.

Modeled on `omp-deck`'s Telegram bridge, but standalone (no deck required) and using
Feishu's **long-connection (WSClient)** mode — no public IP, domain, or webhook URL needed.

## Architecture

```
Feishu ──(WSClient long-conn)──► bridge ──(createAgentSession SDK)──► omp
   ▲                                   │                                  │
   └── card patch (streamed text) ◄────┴──────── text_delta events ◄─────┘
```

- **Inbound**: `im.message.receive_v1` over WSClient → per-chat queue → omp `session.prompt()`.
- **Outbound**: omp `text_delta` events → debounced `im.message.patch` on a card (streaming feel).
- **Persistence**: `chat_id → omp .jsonl session file` in SQLite; resume on restart.

## Prerequisites

- Bun ≥ 1.3.14, Node ≥ 18
- `omp` installed and authenticated (`omp` works in a terminal on this machine)
- A Feishu self-built app (see Onboarding)

## Onboarding (scan to create a Feishu app)

```bash
bun run register-app
```

Prints a URL; open it on a phone with Feishu installed and approve. Auto-creates a
self-built app with the right scopes/events and writes `FEISHU_APP_ID` / `FEISHU_APP_SECRET`
to `.env`. Then add **your own open_id** to `FEISHU_ALLOWED_OPEN_IDS` (find it in Feishu
profile, or message the bot once and read the bridge log).

## Configure

```bash
cp .env.example .env
# fill FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_ALLOWED_OPEN_IDS, OMP_CWD
```

| Var | Required | Description |
|---|---|---|
| `FEISHU_APP_ID` | yes | `cli_...` app id |
| `FEISHU_APP_SECRET` | yes | app secret |
| `FEISHU_ALLOWED_OPEN_IDS` | recommended | comma-separated open_ids allowed to drive the bot |
| `OMP_CWD` | no | working dir for omp sessions (default: repo parent) |
| `OMP_MODEL` | no | pin a model, e.g. `anthropic/claude-sonnet-4` |
| `FEISHU_LARK_INTERNATIONAL` | no | `1` for Lark (open.larksuite.com) |

## Run

```bash
bun run start
```

DM the bot. Send `/reset` to drop the current chat's omp session and start fresh.

## Notes

- `autoApprove: true` — a headless bridge has no terminal to confirm tool calls.
  Tighten if you want manual gates.
- Streaming edits are debounced at 700ms (`STREAM_INTERVAL_MS` in `src/index.ts`).
- Group chats only respond when the bot is @-mentioned.
