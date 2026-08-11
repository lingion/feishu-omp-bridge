<p align="center">
  <a href="https://github.com/lingion/feishu-omp-bridge"><img src="https://img.shields.io/github/stars/lingion/feishu-omp-bridge?style=for-the-badge&logo=github&color=FFD700" alt="Stars"></a>
  <a href="https://github.com/lingion/feishu-omp-bridge/network/members"><img src="https://img.shields.io/github/forks/lingion/feishu-omp-bridge?style=for-the-badge&logo=github&color=8B5CF6" alt="Forks"></a>
  <a href="https://github.com/lingion/feishu-omp-bridge/issues"><img src="https://img.shields.io/github/issues/lingion/feishu-omp-bridge?style=for-the-badge&logo=github&color=EF4444" alt="Issues"></a>
  <a href="https://github.com/lingion/feishu-omp-bridge/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge" alt="License"></a>
  <br>
  <a href="https://bun.sh/"><img src="https://img.shields.io/badge/运行时-Bun-FFB714?style=flat-square&logo=bun&logoColor=white" alt="Bun"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/语言-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://open.feishu.cn/"><img src="https://img.shields.io/badge/平台-Feishu%2FLark-3370FF?style=flat-square" alt="Feishu"></a>
  <a href="https://github.com/can1357/oh-my-pi"><img src="https://img.shields.io/badge/后端-omp-6366F1?style=flat-square" alt="omp"></a>
  <a href="https://github.com/lingion/feishu-omp-bridge/commits/main"><img src="https://img.shields.io/github/last-commit/lingion/feishu-omp-bridge?style=flat-square" alt="最近提交"></a>
</p>

# feishu-omp-bridge · 飞书 omp 桥

> DM 或 @机器人 → 驱动 omp 编程 agent → 流式卡片回复
>
> A Feishu/Lark <-> omp bidirectional messaging bridge triggered by DM or @mention.

[English](README.md) | [中文说明](README-zh-CN.md)

当前版本 **0.1.0** · 最后验证 2026-08-11 · 已实飞书自建应用闭环测试

```
飞书/Lark 消息
      |
      v
WSClient 长连接（无需公网 IP/域名）
      |
      v
bridge 进程 (Bun)
      |
      v
omp createAgentSession SDK → omp coding agent
      |
      v
流式卡片回飞书
```

本桥**不是** OpenClaw `@openclaw/feishu` 或 Hermes Agent 飞书平台的 1:1 移植（两者均约 8,000 行），而是覆盖核心消息通道的较小实现（2,706 行 TypeScript）。
以下所有能力均对照**本机已安装的参考源码**交叉验证（非文档页）。

## 已实现

| 能力 | 对照来源 |
|---|---|
| 机器人私聊 + 群聊（WSClient 长连接） | OpenClaw / Hermes |
| 流式卡片回复（debounced patch） | Hermes `flush` |
| 接收**图片** → omp ImageAttachment | Hermes `_download_feishu_image` |
| 接收 **.txt/.md** 文件 — 内容 inline（<64 KiB） | Hermes `_maybe_extract_text_document` |
| 接收**二进制**文件 — 保存 + 占位 + 路径供 omp `read` 工具读取 | Hermes saved-attachment 模式 |
| 接收**音频/视频/贴纸** — 保存 + 占位 | Hermes `_handle_message_event_data` |
| 发送**图片/文件/音频/视频** — 原生气泡 | Hermes `send_image/file/voice/video` |
| 富文本 **post** 解析（入站→纯文本）+ 构建（出站，fenced code-block 隔离） | Hermes `_build_markdown_post_rows` |
| 转发/合并转发消息解析 | Hermes `_normalize_merge_forward_message` |
| `dmPolicy`: allowlist / pairing / open | OpenClaw `dmPolicy` |
| `groupPolicy`: open / allowlist / disabled + requireMention + 逐群覆盖 | OpenClaw `groupPolicy` |
| `groupSessionScope`: group / group_sender / group_topic / group_topic_sender | OpenClaw `groupSessionScope` |
| 精确 @bot 检测（hydrate bot open_id `/bot/v3/info`） | Hermes `_mentions_self` |
| `replyInThread` — message.reply + 话题线程创建 | OpenClaw `replyInThread` |
| 管理员/用户命令分级 | Hermes tier split |
| per-chat 串行锁（LRU） | Hermes `_get_chat_lock` |
| 卡片按钮去重 | Hermes `_is_card_action_duplicate` |
| 斜杠命令：`/help` `/whoami` `/status` `/reset` `/model` `/sessions` `/resume` `/stop` `/usage` | Hermes 命令集 |
| per-chat 持久 `/model` 覆盖（重启不丢） | Hermes `/model` |
| 投递账本（崩溃后 at-least-once 重投） | Hermes `state.db` |
| 打字指示器（OK reaction） | Hermes `send_typing` |
| 机器人循环保护（默认忽略其他机器人） | OpenClaw `allowBots` |
| `resolveSenderNames` 通过 `contact.v3.user.get` + TTL 缓存 | Hermes `_resolve_sender_name_from_api` |
| 机器人入群打招呼 | OpenClaw |
| 事件：机器人进/退群、撤回、已读、drive 评论、会议邀请 | Hermes `_on_*` |
| 飞书工作区工具（doc/wiki/drive/bitable/chat 通过官方 lark-mcp） | OpenClaw `tools.*` |
| 扫码建应用（`registerApp`） | 飞书 SDK |
| JSON5 配置（对齐 `channels.feishu.*`） | OpenClaw config |
| launchd 服务安装 | Hermes gateway install |

## 未实现

每个缺口要么是 omp 架构硬限制，要么是刻意裁剪的子系统。

| 缺口 | 原因 |
|---|---|
| 交互式审批按钮 | omp approval 是**同步策略** — 没有 Hermes `resolve_gateway_approval()` 那样的阻塞钩子 |
| 在线追问卡片 | 同上 — omp 无阻塞 ask 钩子 |
| Drive 评论规则引擎 | ~1,800 行子系统（Hermes `feishu_comment.py`）未移植 |
| 自动入会 | 需要 `vc:meeting.bot.join:write` 权限 — 未移植 |
| 音频转写（ASR） | 无内置 ASR provider（Hermes/OpenClaw 也需另外配置） |
| `/retry` `/undo` | omp 无公开 session retry/undo API |
| `/sessions` `/resume` 内容 | 注册表已接，列表可显示 — 但按名恢复仍是占位 |
| 多账号 | 配置 schema 支持 `accounts.*`，运行时仅用默认账号 |

## 实测

### 真飞书应用测试（观察日志确认）

| 测试项 | 结果 |
|---|---|
| 文本 → 流式卡片回复 | ✅ |
| 图片 → omp 看图 | ✅ |
| `.txt` 文件 → 内容 inline，omp 读到 | ✅ |
| `.pdf` 文件 → 保存 + omp `read` 工具打开 | ✅ |
| 斜杠命令（`/help` `/status` `/model` `/reset` `/whoami` `/stop` `/usage`） | ✅ |
| 多会话持久化 + 重启恢复 | ✅ |
| 访问控制（陌生人不放行） | ✅ |
| 群聊 @bot 检测 + 回复 | ✅ |
| 入群打招呼 | ✅ |
| 打字指示器（OK reaction） | ✅ |

### 单元验证

| 模块 | 检查项 |
|---|---|
| `rich.ts` post 解析/构建 | ✅ 展平 post→text; fenced code-block 分隔为 3 行 |
| `concurrency.ts` chat lock | ✅ 同 chat 串行 A→B，不同 chat 并发 |
| `concurrency.ts` card dedup | ✅ 首次 false，重复 true |
| `rich.ts` forward/merge-forward 解析 | ✅ sender+body 正确提取 |
| `tsc --noEmit` | ✅ 零错误 |

### 尚未实测

- 群聊消息批处理窗口
- 贴纸入站
- Drive 评论 / 会议邀请事件投递
- 投递账本崩溃后重投
- launchd 服务安装部署

## 快速开始

```bash
# 1. 克隆 + 装依赖
git clone https://github.com/lingion/feishu-omp-bridge.git
cd feishu-omp-bridge
bun install   # 国内: --registry=https://registry.npmmirror.com

# 2. 扫码建飞书应用
bun run register-app

# 3. 加你的 open_id 到 .env
echo "FEISHU_ALLOWED_OPEN_IDS=ou_你的ID" >> .env

# 4. 启动
bun run start

# 可选: 装 macOS launchd 服务（开机自启，崩溃重启）
bun run service:install
```

`register-app` 会把 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 写入 `.env`。

## 配置

复制 `config.example.json5` 为 `feishu-bridge.json5` 获得完整 schema。
`.env` 是凭证兜底源。

```json5
{
  domain: "feishu",  // 国际版用 "lark"
  dmPolicy: "allowlist",
  allowFrom: ["ou_xxx"],
  groupPolicy: "allowlist",
  groupAllowFrom: ["oc_xxx"],
  requireMention: true,
  groupSessionScope: "group",
  ompCwd: "/Users/你/项目",
  ompModel: null,     // 固定模型，如 "anthropic/claude-sonnet-4"
  streaming: { mode: "partial", chunkMode: "length" },
  deliveryLedger: true,
  tools: { doc: true, chat: true, wiki: true, drive: true, bitable: true },
}
```

## 斜杠命令

以纯文本发送（飞书无原生斜杠菜单）。

| 命令 | 说明 | 仅管理员 |
|---|---|---|
| `/help` | 可用命令（分级感知） | |
| `/whoami` | open_id + 等级 + 命令权限 | |
| `/status` | domain / ompCwd / model / policies | |
| `/reset` | 重置当前 chat 的 omp session | |
| `/model [名称]` | 查看或（管理员）设置本 chat 模型 | 设置 |
| `/stop` | 中断正在跑的 omp turn | |
| `/usage` | 上下文/token 用量 | |
| `/sessions` | 列出已持久化 session | ✅ |
| `/resume <名称>` | 按名恢复 session | ✅ |

## 运维

```bash
bun run start                # 前台运行
bun run service:install      # launchd（开机自启，崩溃重启）
bun run service:uninstall
tail -f bridge.stderr.log    # 实时日志
```

## 架构（2,706 行）

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/index.ts` | 531 | 主桥：WSClient 入站 → access/commands/media → omp → 流式卡片 |
| `src/media.ts` | 262 | 图片/文件/音频/视频上下行、downloadToPath、typing |
| `src/commands.ts` | 193 | 斜杠命令注册 + 分级路由 |
| `src/omp.ts` | 174 | omp `createAgentSession` + resume + sendPrompt + model 覆盖 |
| `src/access.ts` | 170 | DM/群策略、配对码、管理员/用户分级 |
| `src/config-loader.ts` | 158 | JSON5 默认合并 + 校验 + 路径解析 |
| `src/rich.ts` | 153 | post 解析/构建、forward/merge-forward、share-chat |
| `src/config-types.ts` | 124 | 配置类型定义 |
| `src/feishu-tools.ts` | 116 | lark-mcp 安装 + scope 指引 |
| `src/store.ts` | 104 | SQLite：chat→session 映射 + per-chat model 覆盖 |
| `src/ledger.ts` | 102 | at-least-once 投递账本 |
| `src/batcher.ts` | 101 | per-chat 消息批处理（快发合并） |
| `src/service.ts` | 83 | launchd plist 生成 + 安装/卸载 |
| `src/events.ts` | 79 | 事件：进/退群、撤回、已读、drive 评论、会议 |
| `src/onboard.ts` | 72 | 扫码建应用（`registerApp`） |
| `src/config.ts` | 65 | 遗留 env 配置（向后兼容） |
| `src/concurrency.ts` | 57 | per-chat LRU 锁 + 卡片去重 |
| `src/mentions.ts` | 52 | bot 身份 hydrate + 精确 @bot 检测 |
| `src/sender.ts` | 38 | 发送者名解析（contact API + TTL 缓存） |
| `src/scope.ts` | 36 | groupSessionScope key + bot-loop 检测 |
| `src/types.ts` | 36 | `im.message.receive_v1` 事件类型 |

## 安全

- `autoApprove: true` — 无头桥自动批准 omp 工具调用。`allowFrom` 务必锁死。
- `.env`（密钥）、`*.db`（session/pairing/ledger）、`node_modules/` 均 git-ignore。

## 交叉验证说明

"已实现"表中每项能力均对照**本机已安装的源码**检查：
- Hermes Agent: `~/.hermes/hermes-agent/plugins/platforms/feishu/adapter.py`（8,167 行）
- OpenClaw: `/usr/local/lib/node_modules/openclaw/docs/channels/feishu.md`

参考插件能做而本桥不能的，均标注原因（omp 架构限制或裁剪子系统），不掩饰。

## 维护者

- **Lingion**: 主桥、飞书/Lark 适配器、omp 集成

## 许可证

MIT
