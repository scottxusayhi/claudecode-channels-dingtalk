# DingTalk Channel for Claude Code

让你通过钉钉和 Claude Code 对话。支持私聊和群聊，支持文字、图片和文件消息。

**Quick start** — 把下面这段话粘贴给你的 Claude Code：

> 帮我安装钉钉 channel 插件 https://github.com/scottxusayhi/claudecode-channels-dingtalk ，按照 README 里的步骤完成配置。

---

## How it works

- 使用钉钉 [Stream Mode](https://open.dingtalk.com/document/orgapp/stream)（出站 WebSocket），不需要公网地址。
- 钉钉消息以 `<channel source="dingtalk" ...>` 标签进入 Claude Code 会话。
- Claude 通过 MCP `reply` 工具回复到钉钉。
- 通过 `/dingtalk:access` 技能管理谁可以跟你的 bot 对话。

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

没反应？在 Claude 会话中运行 `/mcp` 查看 MCP 服务状态。

## Features

- **Text messages** — 收发文字消息
- **Image messages** — 接收图片，Claude 可以看图理解内容
- **File messages** — 收发文件（PDF、文档等）
- **Group chat** — 在群里 @机器人触发对话
- **Access control** — 白名单机制，防止未授权访问

## Security

- 所有凭据通过环境变量或本地配置文件加载，不存在于源码中
- `config.json` 文件权限为 `600`（仅所有者可读写）
- 白名单变更只能通过终端中的 `/dingtalk:access` 技能操作，不接受来自钉钉消息的指令
- `robotCode` + `AppSecret` 可以以你的 bot 身份发消息，请像密码一样保管

## File layout

```
├── .claude-plugin/plugin.json   # plugin manifest
├── .mcp.json                     # MCP server wiring
├── package.json
├── server.ts                     # the channel server
└── skills/access/SKILL.md        # /dingtalk:access skill
```

## Requirements

- [Bun](https://bun.sh/) runtime
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI

## License

Apache-2.0
