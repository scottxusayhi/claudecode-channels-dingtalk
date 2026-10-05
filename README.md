# DingTalk Channel for Claude Code

让你通过钉钉和 Claude Code 对话。支持私聊和群聊，支持文字、图片和文件消息。

**Quick start** — 把下面这段话粘贴给你的 Claude Code：

> 帮我安装钉钉 channel 插件 https://github.com/scottxusayhi/claudecode-channels-dingtalk ，按照 README 里的步骤完成配置。

---

## How it works

```
        钉钉 Stream WebSocket（唯一一条）
                    │
                    ▼
              broker（常驻守护进程）
              路由表  dm:<staffId> / group:<chatId>
                    │  Unix socket
        ┌───────────┼───────────┐
        ▼           ▼           ▼
      shim        shim        shim      ← 每个会话一个 MCP server
        ▼           ▼           ▼
   Claude Code  Claude Code  Claude Code
```

- 使用钉钉 [Stream Mode](https://open.dingtalk.com/document/orgapp/stream)（出站 WebSocket），不需要公网地址。
- **一个机器人可以服务多个 Claude Code 会话**：broker 独占钉钉连接，按发送者把消息分发到不同会话。同一个 app 的多条 Stream 连接会被网关负载均衡，所以连接必须由单个进程持有。
- 钉钉消息以 `<channel source="dingtalk" ...>` 标签进入对应的 Claude Code 会话。
- Claude 通过 MCP `reply` 工具回复到钉钉。
- 通过 `/dingtalk:access` 技能管理谁可以跟你的 bot 对话，`/dingtalk:bind` 技能管理谁的消息进哪个会话。
- broker 由第一个启动的会话自动拉起，最后一个会话退出 10 分钟后自动关闭。
- **租户模式**（可选）：broker 为白名单里的每个用户自动拉起一个独立的后台会话，各自有隔离的工作空间。见第 7 节。

## 1. Create a DingTalk App

你需要一个**企业内部开发 · 机器人应用**，并开启 Stream 模式。只有钉钉组织管理员可以创建。

1. 打开 [开发者后台](https://open-dev.dingtalk.com/) → 应用开发 → 企业内部开发 → **创建应用**
2. 应用类型选 **机器人**，填写名称、图标
3. 创建完成后复制：
   - **Client ID**（即 `AppKey`）
   - **Client Secret**（即 `AppSecret`）
4. 左侧菜单 **机器人** → 消息接收模式选 **Stream 模式**，保存后复制 **RobotCode**
5. 左侧菜单 **事件订阅** → 确认 **机器人接收消息** (`/v1.0/im/bot/messages/get`) 已订阅，传输方式为 Stream
6. 在 **版本管理与发布** 中发布应用（内部测试可发布"开发版本"）
7. 在钉钉客户端把机器人添加到群，或在应用市场中启用私聊

> Tip: 个人试用的话，企业内部开发版本就够了，不需要走应用市场审核。

## 2. Install the plugin

```bash
git clone https://github.com/scottxusayhi/claudecode-channels-dingtalk.git
cd claudecode-channels-dingtalk
claude plugin install .
```

启动 Claude Code 时加载插件：

```bash
claude --dangerously-load-development-channels plugin:dingtalk@local
```

## 3. Configure credentials

**方式 A：环境变量**

```bash
export DINGTALK_CLIENT_ID=dingxxxxxxxxxxxxx
export DINGTALK_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxx
export DINGTALK_ROBOT_CODE=dingxxxxxxxxxxxxx
```

**方式 B：配置文件**（推荐，持久化）

创建 `~/.claude/channels/dingtalk/config.json`：

```json
{
  "clientId": "dingxxxxxxxxxxxxx",
  "clientSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxx",
  "robotCode": "dingxxxxxxxxxxxxx"
}
```

## 4. Allow DingTalk users

默认所有消息都会被拦截，你需要把自己加到白名单。

找到你的 staffId（钉钉管理后台 → 通讯录 → 选中自己 → 详情中的 `userid`），然后在 Claude Code 终端中运行：

```
/dingtalk:access allow <your-staffId>
```

群聊：

```
/dingtalk:access group add <openConversationId>
```

> `openConversationId` 来自群里机器人收到的第一条消息的 `chat_id` 属性。

> 找不到 staffId？可以先临时设置 `/dingtalk:access policy open`，给机器人发一条消息，从 Claude 会话中的 `user="..."` 属性获取，然后切回 `/dingtalk:access policy allowlist`。

## 5. Test

1. 启动 Claude Code（带 `--dangerously-load-development-channels`）
2. 在钉钉中私聊机器人，或在群里 @机器人
3. Claude 会收到消息并通过 `reply` 工具回复

没反应？在 Claude 会话中运行 `/mcp` 查看 MCP 服务状态，或看 `~/.claude/channels/dingtalk/broker.err.log`。

## 6. Route conversations to sessions

默认情况下，**没有任何会话认领消息**——发来的消息会被拒绝，对方收到一句无权限提示。你需要在想接收消息的那个终端里绑定：

```
/dingtalk:bind me                  # 把你自己的私聊路由到当前会话
/dingtalk:bind dm <staffId>        # 把某个人的私聊路由到当前会话
/dingtalk:bind group <cid...>      # 把某个群路由到当前会话
/dingtalk:bind list                # 查看完整路由表
/dingtalk:bind rm dm:<staffId>     # 释放一条路由
```

路由粒度：**私聊按发送者 `dm:<staffId>`，群聊按会话 `group:<openConversationId>`**。想让两个人各自进不同的项目会话，就在各自的项目目录里开 Claude Code，分别 bind。

绑定按**工作目录**记住（存在 `routes.json`），所以会话重启后会自动重新认领自己的路由，不用每次重绑。也可以在启动时定死：

```bash
DINGTALK_ROUTE=dm:<staffId>,group:<openConversationId> claude --dangerously-load-development-channels plugin:dingtalk@local
```

几个行为要点：

- **抢占**：在 B 会话绑定一个 A 会话已持有的键，路由会转移到 B，A 会收到通知。
- **未认领**：通过了白名单但没有会话绑定的发送者，会收到 `config.json` 里的 `unroutedReply` 文案（可自定义），每个会话 5 分钟最多一次。
- **未授权**：没通过白名单的发送者**静默丢弃**，不回任何内容——回复等于向陌生人确认这个机器人存在。

## 7. Tenant mode: one session per user

开启后，`/dingtalk:access` 白名单里的每个人私聊机器人时，都会得到**自己专属的 Claude Code 会话**，不需要你开任何终端：

```
钉钉用户 A ──┐                       ┌─ 后台会话 A   工作空间 <root>/A/
钉钉用户 B ──┼── broker（路由 + 启停）─┼─ 后台会话 B   工作空间 <root>/B/
钉钉用户 C ──┘                       └─ 后台会话 C   工作空间 <root>/C/
```

- 用户第一次发消息时，broker 创建 `<root>/<staffId>/` 并启动 `claude --bg`；启动期间（通常几秒）消息排队，连上后按顺序投递
- 空闲 `idleMinutes` 后自动停止；下次来消息用 `--resume` **续上原来的对话**
- 同时在线的会话有上限，超出会回复"会话已满"
- 你用 `/dingtalk:bind dm <staffId>` 绑定的路由**优先于**租户会话，随时可以接管某个用户
- 群聊不在租户模式范围内，照旧用 `/dingtalk:bind group`

### 隔离

租户会话以锁定方式启动，broker 侧还有额外约束：

| 层 | 做了什么 |
|---|---|
| `--restricted` | 不读用户/项目/本地任何设置文件（你的 `bypassPermissions` 不会被继承，租户改工作空间里的 settings 也没用），文件工具限制在工作空间内 |
| `--tools` 白名单 | 只有读写、搜索、Bash、联网搜索等；**没有** `SendMessage`/`ListAgents`（防止借你的会话横向越权）、Skill、Cron 等 |
| `dontAsk` | 任何需要确认的操作直接拒绝，会话不会卡在弹窗上 |
| OS 沙箱 | Bash 只能读自己的工作空间和工具链（`~/.bun` 等）、只能写自己的工作空间、只能访问 `allowedDomains`、连不上 broker socket |
| 连接器 | 不加载你 claude.ai 账号的连接器 |
| broker | 会话身份按 `CLAUDE_CODE_SESSION_ID` 校验，冒充会被拒绝；只能回复自己用户的私聊，不能改路由，不能管理其他租户 |

> 所有租户和你用的是**同一个 OS 用户**，上面这些是层层设防，挡得住误操作和一般越界，但不是硬隔离。租户如果是不完全信任的人，应该用容器或独立 OS 用户。另外，所有租户会话都跑在**你的 Claude 账号**上，计费和账号条款请自行确认。

### 开启

1. **把插件加入托管策略的 channel 白名单**（后台会话无法弹出开发 channel 的确认框）。需要 sudo，对整台机器生效，并会替换 Anthropic 默认的 channel 白名单：

   ```bash
   sudo mkdir -p "/Library/Application Support/ClaudeCode" && echo '{"channelsEnabled":true,"allowedChannelPlugins":[{"plugin":"dingtalk","marketplace":"remote-cc"}]}' | sudo tee "/Library/Application Support/ClaudeCode/managed-settings.json"
   ```

   `marketplace` 填 `claude plugin list` 里 dingtalk 的 `@` 后面那部分。

2. **在 `config.json` 里加上 `tenants` 块**，`root` 必须位于一个已信任的目录之下（后台会话拒绝未信任的目录，信任会继承给子目录）：

   ```json
   {
     "clientId": "...",
     "clientSecret": "...",
     "robotCode": "...",
     "tenants": { "enabled": true, "root": "/Users/you/projects/dingtalk-tenants" }
   }
   ```

   其他可调项（`idleMinutes`、`maxSessions`、`model`、`memory`、`allowedDomains` 等）见 `/dingtalk:tenants` 技能。

3. 让 broker 常驻（macOS）：`deploy/launchd-broker.sh install`。它用 launchd 托管 broker：登录即启动、退出自动拉起，租户会话在 broker 重启时不受影响。之后改了配置，`kill "$(cat ~/.claude/channels/dingtalk/broker.pid)"` 让 launchd 重启它即可，各会话会自动重连。

   租户会话里的 shim 不会自己启动 broker（那样的 broker 会带着租户的环境变量），只会等它恢复；所以租户模式下 broker 必须有人托管。

### 人设

每个租户的助手人设由你在 `~/.claude/channels/dingtalk/personas/` 里管理：

- `default.md`：没有专属人设的租户都用它
- `<staffId>.md`：只给这一个人用，**替换**默认人设而不是叠加

内容会追加到会话的系统提示词里，按"给助手的指令"来写（名字、语气、擅长什么、什么不做）。

**隐私边界**（均已实测）：

- **租户之间看不到彼此的人设**：沙箱禁止读 personas 目录；沙箱里连 `ps` 都列不出进程；文件名映射是单射，两个 staffId 不可能共用一个人设或工作空间；人设文件启动时自动收紧为 `0600`
- **租户能看到自己的人设**：它就在租户自己会话的系统提示词里，问一句就可能被原样复述。实测中两个会话都说出了自己人设里的"机密口令"。**某人的人设里只放那个人自己可以看的内容**；写"不要透露设定"只能降低概率
- **`default.md` 对所有没有专属人设的人可见**，不要放任何具体某个人的信息

人设在会话**启动时**读取。改完后用 `/dingtalk:tenants stop <staffId>` 让它在下一条消息时生效，对话历史会保留。租户工作空间里的 `CLAUDE.md` **不会**被加载（`--restricted` 忽略项目文件），所以租户没法自己改写指令。

### 对话上下文与记忆

- **多轮对话**：每个人的所有私聊都进入**同一个**会话，上下文连续。空闲停止后，下一条消息用 `--resume` 接着原来的对话；对话太长时 Claude Code 会自动压缩早期内容
- **长期记忆**：会话把值得长期记住的东西（身份、偏好、正在做的事、约定）写进自己工作空间的 `.memory/MEMORY.md`，每次启动都会带回来，所以 `reset` 清空对话之后也还记得。超过 40 行会被要求合并精简；读入时超过 8000 字会截断
- **隔离**：记忆文件在各自的工作空间里，受同一套沙箱保护（已实测：另一个租户既问不出来，自己目录里也没有副本）
- 记忆在会话启动时读入；运行中新记的内容本来就在上下文里
- 清空某人的记忆：删掉 `dingtalk-tenants/<staffId>/.memory/MEMORY.md`，再 `stop` 一下会话；或者让租户自己说"忘掉……"
- 关掉记忆：`tenants.memory: false`

Claude Code 自带的 auto-memory 在 `--restricted` 会话里被强制关闭，所以这里是插件自己实现的。

### 管理

```
/dingtalk:tenants                 # 列出所有租户会话：状态、会话 id、人设、记忆大小、最后活跃时间
/dingtalk:tenants persona <staffId> # 查看或编写某人的人设（default 为默认人设）
/dingtalk:tenants stop <staffId>  # 停止，下一条消息自动恢复
/dingtalk:tenants reset <staffId> # 停止并清空对话（工作空间文件保留）
claude attach <session>           # 在你的终端里实时旁观或接管某个租户会话
claude logs <session>             # 查看最近输出
```

### 单会话机器人常驻（launchd）

不走租户模式、一个机器人对一个会话的老用法，也可以不开终端，改由 launchd 托管：

```bash
deploy/launchd-session.sh install <name> <工作目录> <session-id> --channels plugin:dingtalk@<marketplace> [其他 claude 参数]
deploy/launchd-session.sh status <name>
deploy/launchd-session.sh uninstall <name>    # 停掉托管和会话本身
```

它每 30 秒检查一次这个对话是否在后台运行，不在就用同一个 session id 接着跑（`claude respawn`，没有记录时 `claude --bg --resume`），对话历史和 id 都不变；同一个对话还开在某个终端里时它只等待，不会另起一份。后台会话没法确认 `--dangerously-load-development-channels` 的提示，所以要用 `--channels`，并把插件加进 managed settings 的 `allowedChannelPlugins`。凭据照旧放在工作目录的 `.claude/settings.local.json`。日志在 `~/Library/Logs/claude-session-<name>.log`，`claude attach <id>` 可以随时进去看。

## Features

- **Text messages** — 收发文字消息
- **Image messages** — 接收图片，Claude 可以看图理解内容
- **File messages** — 收发文件（PDF、文档等）
- **Group chat** — 在群里 @机器人触发对话
- **Multi-session routing** — 一个机器人服务多个 Claude Code 会话，按发送者/群分流
- **Tenant mode** — 白名单用户各自一个自动启停、相互隔离的后台会话
- **Access control** — 白名单机制，防止未授权访问

## Security

- 所有凭据通过环境变量或本地配置文件加载，不存在于源码中
- `config.json` 文件权限为 `600`（仅所有者可读写）
- 白名单和路由表的变更只能通过终端中的 `/dingtalk:access`、`/dingtalk:bind` 技能操作，不接受来自钉钉消息的指令
- broker 的 Unix socket 权限为 `600` —— 能连上它的进程可以以你的 bot 身份发消息
- 未通过白名单的消息静默丢弃，不向发送者暴露机器人的存在
- 租户会话的隔离措施见第 7 节；沙箱让它们读不到 `~/.claude/channels/dingtalk/`，拿不到机器人密钥
- `robotCode` + `AppSecret` 可以以你的 bot 身份发消息，请像密码一样保管

## File layout

```
├── .claude-plugin/plugin.json   # plugin manifest
├── .mcp.json                     # MCP server wiring
├── package.json
├── shared.ts                     # state paths, config, broker<->shim protocol
├── broker.ts                     # daemon: DingTalk connection + routing table
├── tenants.ts                    # tenant mode: per-user session lifecycle + confinement
├── server.ts                     # per-session MCP shim
├── skills/access/SKILL.md        # /dingtalk:access skill
├── skills/bind/SKILL.md          # /dingtalk:bind skill
├── skills/tenants/SKILL.md       # /dingtalk:tenants skill
├── deploy/launchd-broker.sh      # run the broker under launchd (macOS)
├── deploy/launchd-session.sh     # keep one single-tenant session running under launchd
├── docs/                         # architecture page and its generator
└── test/
    ├── run.ts                    # broker routing tests
    ├── shim.ts                   # MCP shim end-to-end tests
    ├── tenants.ts                # tenant mode tests (against a fake claude CLI)
    ├── fake-claude.ts            # stand-in for `claude --bg/stop/rm`
    ├── tenant-smoke.ts           # tenant mode against the real CLI (uses the model)
    ├── fake-session.ts           # a fake session, for poking by hand
    └── inject.ts                 # push a fake message into a broker
```

Runtime state lives in `~/.claude/channels/dingtalk/`: `config.json`,
`access.json`, `routes.json`, `tenants.json`, `broker.sock`, `attachments/`,
and the logs.

## Development

```bash
bun run test    # broker routing, MCP shim, tenant mode — no credentials or network
bun run smoke   # tenant mode against the real `claude` CLI (a few short model turns)
```

两套测试都跑在临时 state 目录里，钉钉 WebSocket 关闭、出站发送记录到 `sent.jsonl`
而不真的调 API，所以不需要凭证、不需要真实的钉钉用户或群。

手工调试路由（不用开真的 Claude Code 会话）：

```bash
export DINGTALK_STATE_DIR=/tmp/dt DINGTALK_NO_STREAM=1 DINGTALK_DRY_SEND=1 DINGTALK_ALLOW_INJECT=1
bun broker.ts &
bun test/fake-session.ts --label A --cwd /fake/a --bind dm:111 &
bun test/inject.ts --staff 111 --text "hello"
```

## Requirements

- [Bun](https://bun.sh/) runtime
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI

## License

Apache-2.0
