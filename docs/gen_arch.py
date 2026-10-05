#!/usr/bin/env python3
"""
Generate docs/multi-tenant-architecture.html — the multi-tenant architecture
page: a process/module diagram and a sequence diagram of a tenant saying
"hello", plus the isolation, state and lifecycle tables.

    python3 docs/gen_arch.py

Hand-drawn inline SVG, no diagram library and no JavaScript, so the page is a
single self-contained file. Colors are GitHub Primer values held in CSS
variables, with a dark palette under prefers-color-scheme.

  - Module diagram: boxes are placed on a grid by hand (see the coordinates
    below); keep arrows in the gaps between boxes and labels clear of lines.
  - Sequence diagram: edit `lanes` and `steps`; rows, numbering, the cold-start
    bracket and label widths are computed.

After editing, render it and look before trusting it:

    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
      --hide-scrollbars --window-size=1300,4300 --screenshot=/tmp/arch.png \
      "file://$PWD/docs/multi-tenant-architecture.html"
"""
import datetime
import html
import pathlib

def esc(s): return html.escape(str(s), quote=True)
def tw(s, cjk=12.5, asc=7.0):
    # Rounded: Python 3.12 made float sum() more precise, and the page should
    # come out byte-identical whichever Python generates it.
    return round(sum(cjk if ord(c) > 0x2E80 else asc for c in s), 2)

# ------------------------------------------------------------------ module diagram
M = []
def rect(x, y, w, h, cls, rx=10): M.append(f'<rect class="{cls}" x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}"/>')
def text(x, y, s, cls='t', anchor='start', extra=''): M.append(f'<text class="{cls}" x="{x}" y="{y}" text-anchor="{anchor}" {extra}>{esc(s)}</text>')
def chip(x, y, w, h, title, *subs, cls='chip'):
    rect(x, y, w, h, cls, 8)
    n = len(subs)
    top = y + h / 2 - (n * 17) / 2 + 2
    text(x + w / 2, top, title, 'ct', 'middle')
    for i, s in enumerate(subs):
        text(x + w / 2, top + 18 + i * 17, s, 'cs', 'middle')
def path(pts, cls='arr', start=False, end=True):
    d = 'M ' + ' L '.join(f'{a} {b}' for a, b in pts)
    heads = (' marker-start="url(#ah-s)"' if start else '') + (' marker-end="url(#ah)"' if end else '')
    M.append(f'<path class="{cls}" d="{d}"{heads}/>')

# external services
rect(40, 20, 560, 110, 'ext')
text(55, 44, '钉钉服务端（企业内部机器人）', 'bt')
chip(55, 56, 160, 62, 'Stream 网关', 'WSS 推送消息', cls='chip ext-chip')
chip(225, 56, 200, 62, 'OpenAPI', 'token · 单聊 · 附件 · 表情', cls='chip ext-chip')
chip(435, 56, 150, 62, 'sessionWebhook', '临时回复地址', cls='chip ext-chip')
rect(760, 20, 400, 110, 'ext')
text(775, 44, 'Anthropic API', 'bt')
chip(775, 56, 370, 62, 'Claude Opus 5.5', '所有租户共用你的 Claude Max 额度', cls='chip ext-chip')

# machine boundary
rect(20, 160, 1160, 632, 'machine', 14)
text(36, 782, '本机（现在是笔记本，计划迁到 Mac mini + launchd 托管）', 'muted')

# broker
rect(40, 190, 550, 360, 'broker')
text(55, 214, 'broker.ts · 常驻单例 · 唯一持有钉钉连接', 'bt')
chip(55, 228, 260, 68, 'Stream 连接', '每 20 秒 ping · 45 秒无 pong 就重连')
chip(325, 228, 250, 68, '发送 · 附件 · 引用', 'webhook → batchSend · 附件存进工作空间')
chip(55, 306, 260, 68, '访问控制', 'access.json 白名单（静默丢弃陌生人）')
chip(325, 306, 250, 68, '路由表', 'dm:<staffId> · group:<chatId>')
chip(55, 384, 520, 68, 'Unix socket 服务（broker.sock，0600）', '换行分隔 JSON：hello · inbound · reply · escalate · tenants')
chip(55, 462, 520, 68, 'TenantManager（tenants.ts）', '注册表 · 启动/恢复/停止 · 身份校验 · 排队 · 拼提示词 · 求助转发', cls='chip tm')

# claude background service with tenant sessions
rect(660, 190, 500, 360, 'service')
text(675, 214, 'Claude Code 后台服务（claude --bg 托管）', 'bt')
for y0, who, tools in ((226, '租户会话 · 用户A', '工具：reply'), (392, '租户会话 · 用户B', '工具：reply · ask_owner')):
    rect(675, y0, 470, 152, 'tenant')
    text(690, y0 + 26, who, 'bt')
    chip(690, y0 + 64, 190, 80, 'shim（server.ts）', 'MCP stdio 接入会话', tools, cls='chip shim')
    for i, line in enumerate(('claude --restricted', 'dontAsk · 内置工具白名单', 'OS 沙箱：只碰自己的工作空间', '人设 + 记忆注入系统提示词')):
        text(895, y0 + 62 + i * 21, line, 'small mono' if i == 0 else 'small')

# storage row
rect(40, 600, 400, 162, 'store')
text(55, 624, '状态目录 ~/.claude/channels/dingtalk/', 'bt')
for i, line in enumerate(('租户沙箱读不到这里', 'config.json 凭证 · access.json 白名单', 'tenants.json 会话注册表 · routes.json', 'personas/ 人设 · prompts/ 拼好的提示词', 'debug.log · broker.sock')):
    text(55, 648 + i * 21, line, 'small muted' if i == 0 else 'small')
rect(460, 600, 440, 162, 'store ws')
text(475, 624, '租户工作空间（每人一个，0700）', 'bt')
for i, line in enumerate(('dingtalk-tenants/<staffId>/', 'attachments/  TA发来的附件（broker 写入）', '.memory/MEMORY.md  长期记忆', '其余是TA自己的文件，只有TA的会话能读写')):
    text(475, 648 + i * 21, line, 'small mono' if i == 0 else 'small')
rect(920, 600, 240, 162, 'store')
text(935, 624, '托管策略（sudo 写入）', 'bt')
for i, line in enumerate(('managed-settings.json', 'channelsEnabled: true', 'allowedChannelPlugins:', '  dingtalk@remote-cc')):
    text(935, 648 + i * 21, line, 'small mono')

# arrows
path([(135, 118), (135, 188)]); text(143, 148, '推送消息', 'label')
path([(375, 190), (375, 120)]); path([(510, 190), (510, 120)])
text(442, 148, 'HTTPS 回复/下载', 'label', 'middle')
path([(1080, 190), (1080, 120)]); text(1072, 148, '模型调用', 'label', 'end')
path([(575, 418), (625, 418), (625, 330), (688, 330)], start=True)
path([(625, 418), (625, 496), (688, 496)])
text(645, 418, 'Unix socket', 'label', 'middle', 'transform="rotate(-90 645 418)"')
path([(575, 512), (658, 512)], cls='arr ctl'); text(617, 534, '启动/停止', 'label', 'middle')
path([(200, 550), (200, 598)]); text(208, 580, '配置 · 注册表 · 日志', 'label')
path([(500, 550), (500, 598)]); text(508, 580, '存附件 · 读记忆拼提示词', 'label')
path([(800, 550), (800, 598)]); text(808, 580, '读写自己的', 'label')
path([(1040, 600), (1040, 552)], cls='arr ctl'); text(1048, 580, '批准 channel', 'label')

module_svg = ('<svg class="diagram" viewBox="0 0 1200 800" role="img" aria-label="进程与模块图">'
              '<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="head" d="M0 0 L10 5 L0 10 z"/></marker>'
              '<marker id="ah-s" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="head" d="M0 0 L10 5 L0 10 z"/></marker></defs>'
              + ''.join(M) + '</svg>')

# ------------------------------------------------------------------ sequence diagram
lanes = [('用户', '钉钉客户端'), ('钉钉服务端', 'Stream / OpenAPI'), ('broker', '路由 · 发送'), ('TenantManager', 'tenants.ts'),
         ('claude CLI', '后台服务'), ('shim', 'server.ts'), ('租户会话', 'Claude Code'), ('Claude 模型', 'Anthropic API')]
X = [75 + i * 150 for i in range(len(lanes))]
U, D, B, T, C, S, K, Mo = range(8)
steps = [
    ('msg', U, D, ['发送「hello」']),
    ('msg', D, B, ['Stream 推送 CALLBACK（WSS）'], '0s'),
    ('ret', B, D, ['先 ack，防止钉钉重投']),
    ('note', B, '白名单 ✓ · 记下 sessionWebhook'),
    ('note', B, '查路由 dm:<staffId> → 没有在线会话'),
    ('msg', B, D, ['加表情「🤔思考中」']),
    ('phase', '冷启动：只在TA的会话已停止时发生；会话在线时直接跳到 ⑱'),
    ('msg', B, T, ['route(staffId, 消息)']),
    ('note', T, '建 / 找工作空间 · 消息入队 · 拼提示词（人设 + 记忆）'),
    ('msg', T, C, ['claude --bg --resume <sid> --restricted', '--channels … --append-system-prompt-file …'], None, True),
    ('msg', C, K, ['在后台启动会话（cwd = TA的工作空间）']),
    ('ret', C, T, ['「backgrounded · 5f3a9c2e」→ 记下短 id'], '+1.3s'),
    ('msg', K, S, ['拉起 MCP server（带 DINGTALK_TENANT）']),
    ('msg', S, K, ['MCP 握手 · 注册 channel']),
    ('note', S, '等握手完成再 +1 秒，免得通知被丢'),
    ('msg', S, B, ['hello {tenant, sessionId}'], '+2.3s'),
    ('note', T, '校验 sessionId 以 5f3a9c2e 开头 ✓ · 绑定路由'),
    ('ret', B, S, ['welcome']),
    ('endphase',),
    ('msg', B, S, ['inbound「hello」（冲刷队列）']),
    ('msg', S, K, ['notifications/claude/channel', '以 <channel> 标签进入对话']),
    ('msg', K, Mo, ['推理（系统提示词含人设 + 记忆）']),
    ('ret', Mo, K, ['调用 reply 工具']),
    ('msg', K, S, ['tools/call reply {chat_id, text}']),
    ('msg', S, B, ['reply 帧']),
    ('note', B, '只许回TA自己的私聊 ✓ · 撤回 🤔'),
    ('msg', B, D, ['POST sessionWebhook（过期则 batchSend）'], '+5.5s'),
    ('msg', D, U, ['「在呢～」']),
]
Q = []
y = 104
n = 0
phase_top = None
items = []
for st in steps:
    kind = st[0]
    if kind == 'phase':
        phase_top = y - 6; phase_label = st[1]; y += 34; continue
    if kind == 'endphase':
        items.append(('phase', phase_top, y - 2, phase_label)); y += 18; continue
    n += 1
    if kind in ('msg', 'ret'):
        _, a, b, labels, *rest = st
        tag = rest[0] if rest else None
        mono = rest[1] if len(rest) > 1 else False
        lines = len(labels)
        ay = y + 14 * (lines - 1) + 8
        items.append(('arrow', n, a, b, labels, ay, kind == 'ret', tag, mono))
        y = ay + 30
    else:
        _, a, label = st
        items.append(('note', n, a, label, y))
        y += 40
height = y + 30
for i, (name, sub) in enumerate(lanes):
    x = X[i]
    Q.append(f'<line class="life" x1="{x}" y1="70" x2="{x}" y2="{height - 10}"/>')
for it in items:
    if it[0] == 'phase':
        _, top, bot, label = it
        Q.append(f'<rect class="phase" x="{X[B] - 70}" y="{top}" width="{X[K] - X[B] + 140}" height="{bot - top}" rx="10"/>')
        Q.append(f'<text class="phase-label" x="{X[B] - 60}" y="{top + 16}">{esc(label)}</text>')
for i, (name, sub) in enumerate(lanes):
    x = X[i]
    Q.append(f'<rect class="lane-head" x="{x - 68}" y="18" width="136" height="50" rx="8"/>')
    Q.append(f'<text class="ct" x="{x}" y="39" text-anchor="middle">{esc(name)}</text>')
    Q.append(f'<text class="cs" x="{x}" y="57" text-anchor="middle">{esc(sub)}</text>')
for it in items:
    if it[0] == 'arrow':
        _, num, a, b, labels, ay, ret, tag, mono = it
        x1, x2 = X[a], X[b]
        pad = 4 if x2 > x1 else -4
        Q.append(f'<path class="{"arr ret" if ret else "arr"}" d="M {x1} {ay} L {x2 - pad} {ay}" marker-end="url(#ah2)"/>')
        cx = (x1 + x2) / 2
        for li, lab in enumerate(labels):
            ly = ay - 7 - 14 * (len(labels) - 1 - li)
            w = round(tw(lab, 12, 6.6) + 10, 2)
            Q.append(f'<rect class="label-bg" x="{round(cx - w / 2, 2)}" y="{ly - 11}" width="{w}" height="14" rx="3"/>')
            Q.append(f'<text class="{"seq-label mono" if mono else "seq-label"}" x="{cx}" y="{ly}" text-anchor="middle">{esc(lab)}</text>')
        Q.append(f'<text class="num" x="14" y="{ay + 4}">{num}</text>')
        if tag: Q.append(f'<text class="tag" x="1192" y="{ay + 4}" text-anchor="end">{esc(tag)}</text>')
    elif it[0] == 'note':
        _, num, a, label, ny = it
        w = round(tw(label, 12.5, 7) + 22, 2)
        Q.append(f'<rect class="note" x="{round(X[a] - w / 2, 2)}" y="{ny - 2}" width="{w}" height="26" rx="6"/>')
        Q.append(f'<text class="note-text" x="{X[a]}" y="{ny + 15}" text-anchor="middle">{esc(label)}</text>')
        Q.append(f'<text class="num" x="14" y="{ny + 15}">{num}</text>')
seq_svg = (f'<svg class="diagram" viewBox="0 0 1200 {height}" role="img" aria-label="用户说 hello 后的时序图">'
           '<defs><marker id="ah2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path class="head" d="M0 0 L10 5 L0 10 z"/></marker></defs>'
           + ''.join(Q) + '</svg>')

CSS = """
:root{--bg:#ffffff;--fg:#1f2328;--muted:#59636e;--line:#818b98;--panel:#f6f8fa;--border:#d1d9e0;
--ext:#fff8e1;--ext-b:#d4a72c;--broker:#e8f2ff;--broker-b:#3b82c4;--service:#eef9f0;--service-b:#3f9b5a;
--tenant:#ffffff;--chip:#ffffff;--tm:#dbeafe;--shim:#ecfdf3;--store:#f6f8fa;--ws:#f3f0ff;--ws-b:#8a63d2;
--accent:#0969da;--ctl:#bc4c00;--note:#fff4c2;--phase:#fbf4ff;--phase-b:#a475f9}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--line:#6e7681;--panel:#161b22;--border:#30363d;
--ext:#2b2410;--ext-b:#9e7b1d;--broker:#0f2236;--broker-b:#4b8fd1;--service:#0f2a18;--service-b:#3f9b5a;--tenant:#0d1117;--chip:#161b22;
--tm:#132b4a;--shim:#0f2a18;--store:#161b22;--ws:#1f1838;--ws-b:#8a63d2;--accent:#4493f8;--ctl:#f0883e;--note:#3a3115;--phase:#1e1530;--phase-b:#8957e5}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
main{max-width:1240px;margin:0 auto;padding:40px 24px 80px}
h1{font-size:30px;margin:0 0 6px}h2{font-size:22px;margin:48px 0 12px;padding-top:12px;border-top:1px solid var(--border)}
.lede{color:var(--muted);margin:0 0 24px;font-size:16px}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:20px 0 8px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
.card b{display:block;font-size:20px}.card span{color:var(--muted);font-size:13px}
figure{margin:16px 0;background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:12px}
figcaption{color:var(--muted);font-size:13px;padding:6px 8px 0}
.diagram{width:100%;height:auto;display:block}
.diagram text{fill:var(--fg);font-size:13px}
.diagram .bt{font-weight:600;font-size:14px}.diagram .ct{font-weight:600;font-size:13px}
.diagram .cs,.diagram .small{font-size:12px}.diagram .muted{fill:var(--muted)}.diagram .small.muted{fill:var(--muted)}
.diagram .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.diagram .label{font-size:11.5px;fill:var(--muted)}
.ext{fill:var(--ext);stroke:var(--ext-b);stroke-width:1.5}.ext-chip{fill:var(--chip);stroke:var(--ext-b)}
.machine{fill:none;stroke:var(--line);stroke-width:1.5;stroke-dasharray:8 6}
.broker{fill:var(--broker);stroke:var(--broker-b);stroke-width:1.5}.service{fill:var(--service);stroke:var(--service-b);stroke-width:1.5}
.tenant{fill:var(--tenant);stroke:var(--service-b);stroke-width:1.2}
.chip{fill:var(--chip);stroke:var(--broker-b);stroke-width:1}.tm{fill:var(--tm)}.shim{fill:var(--shim);stroke:var(--service-b)}
.store{fill:var(--store);stroke:var(--line);stroke-width:1.2}.ws{fill:var(--ws);stroke:var(--ws-b)}
.arr{fill:none;stroke:var(--accent);stroke-width:1.8}.arr.ctl{stroke:var(--ctl);stroke-dasharray:6 4}
.arr.ret{stroke-dasharray:5 4;stroke:var(--muted)}
.head{fill:var(--accent)}
.life{stroke:var(--border);stroke-width:1.5;stroke-dasharray:4 4}
.lane-head{fill:var(--chip);stroke:var(--line)}
.label-bg{fill:var(--panel)}
.seq-label{font-size:12px}
.num{font-size:11px;fill:var(--muted);font-weight:600}
.tag{font-size:12px;font-weight:700;fill:var(--ctl)}
.note{fill:var(--note);stroke:var(--ext-b);stroke-width:.8}.note-text{font-size:12px}
.phase{fill:var(--phase);stroke:var(--phase-b);stroke-dasharray:6 4}.phase-label{font-size:12px;fill:var(--phase-b);font-weight:600}
table{width:100%;border-collapse:collapse;margin:12px 0;font-size:14px}
th,td{border-bottom:1px solid var(--border);padding:8px 10px;text-align:left;vertical-align:top}
th{background:var(--panel);font-weight:600}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;background:var(--panel);padding:1px 5px;border-radius:5px;border:1px solid var(--border)}
ul{padding-left:22px}li{margin:4px 0}
.legend{display:flex;gap:20px;flex-wrap:wrap;color:var(--muted);font-size:13px;padding:4px 8px}
.legend i{display:inline-block;width:26px;border-top:2px solid var(--accent);vertical-align:middle;margin-right:6px}
.legend i.ctl{border-top:2px dashed var(--ctl)}.legend i.ret{border-top:2px dashed var(--muted)}
footer{color:var(--muted);font-size:12px;margin-top:48px}
@media (max-width:900px){.cards{grid-template-columns:repeat(2,1fr)}}
"""

body = f"""
<h1>钉钉多租户 Claude Code · 架构</h1>
<p class="lede">一个钉钉企业内部机器人作入口；白名单里的每个人，都有一个自己的、相互隔离的 Claude Code 会话。</p>
<div class="cards">
 <div class="card"><b>1 条连接</b><span>只有 broker 连钉钉；同一 AppKey 多连接会被网关随机分流</span></div>
 <div class="card"><b>1 人 1 会话</b><span>后台会话 + 私有工作空间，按需启动、空闲停止、续上原对话</span></div>
 <div class="card"><b>7 层隔离</b><span>从钉钉可见范围到 OS 沙箱，见第 3 节</span></div>
 <div class="card"><b>≈5.5 秒</b><span>冷启动到回复（实测）；会话在线时 3–5 秒</span></div>
</div>

<h2>1. 进程与模块</h2>
<figure>{module_svg}
<div class="legend"><span><i></i>数据流</span><span><i class="ctl"></i>控制：启动进程 / 托管策略</span></div>
<figcaption>broker 是本机唯一和钉钉说话的进程；每个租户会话由 Claude Code 后台服务托管，通过自己的 shim 经 Unix socket 接入 broker。你自己的交互式会话也可以接入同一个 broker（绑定路由），图中省略。</figcaption></figure>
<table>
<tr><th>组件</th><th>文件</th><th>职责</th></tr>
<tr><td>broker</td><td><code>broker.ts</code></td><td>常驻单例。持有唯一的钉钉 Stream 连接（20 秒 ping、45 秒无 pong 重连），做白名单、路由、回复发送、附件下载、引用解析；把没有会话的白名单私聊交给 TenantManager。</td></tr>
<tr><td>TenantManager</td><td><code>tenants.ts</code></td><td>每个租户的注册表、工作空间、启动参数（含沙箱配置）、身份校验、消息排队、提示词拼装（人设 + 记忆）、求助转发、空闲回收。</td></tr>
<tr><td>shim</td><td><code>server.ts</code></td><td>每个会话一个的 MCP server。把 broker 推来的消息变成 <code>notifications/claude/channel</code>，把 <code>reply</code> / <code>ask_owner</code> 工具调用转回 broker。租户模式下只暴露这两个工具。</td></tr>
<tr><td>协议与配置</td><td><code>shared.ts</code></td><td>状态路径、配置解析（含 <code>tenants</code> 块）、broker↔shim 的换行分隔 JSON 协议。</td></tr>
<tr><td>管理技能</td><td><code>skills/*</code></td><td><code>/dingtalk:access</code> 白名单 · <code>/dingtalk:bind</code> 路由 · <code>/dingtalk:tenants</code> 租户、人设、记忆。</td></tr>
</table>

<h2>2. 用户说「hello」之后</h2>
<p>以用户B的会话已停止（空闲后被结束）为例；右侧橙色时间取自日志里第一次冷启动的实测。</p>
<figure>{seq_svg}
<div class="legend"><span><i></i>调用 / 消息</span><span><i class="ret"></i>返回</span><span>黄色便签：模块内部处理</span><span>紫色虚框：只有冷启动才走</span></div>
<figcaption>会话在线时，broker 查到路由直接执行 ⑱ 起的步骤；同一会话里的后续消息按顺序排队进入同一段对话。</figcaption></figure>
<ul>
<li><b>为什么要等握手再 +1 秒（⑭）</b>：Claude Code 在 MCP 握手后才注册 channel 处理器，之前到达的通知会被静默丢弃 —— 真机上第一条消息丢过，这一步就是为此加的。</li>
<li><b>为什么校验 sessionId（⑮–⑯）</b>：<code>claude --bg</code> 自己分配会话 id；shim 上报的 <code>CLAUDE_CODE_SESSION_ID</code> 必须以 broker 启动时拿到的短 id 开头，冒充别的租户会被拒绝并断开。</li>
<li><b>出错时</b>：启动失败或 90 秒内没连上 → 回复TA「会话启动失败」并停掉半成品；同时在线会话超过上限 → 回复「会话已满」；钉钉回调里没有 staffId 的外部联系人 → 丢弃。</li>
<li><b>引用回复与附件</b>：被引用的那条以引用块放在消息前面；附件下载到TA工作空间的 <code>attachments/</code>，路径随消息一起给会话。</li>
</ul>

<h2>3. 隔离：一层一层</h2>
<table>
<tr><th>层</th><th>谁来执行</th><th>挡住什么</th></tr>
<tr><td>钉钉可见范围 + <code>access.json</code> 白名单</td><td>钉钉平台 / broker</td><td>不在范围内的人发不进来；不在白名单的私聊被静默丢弃，不暴露机器人存在。</td></tr>
<tr><td><code>--restricted</code></td><td>Claude Code</td><td>不读用户 / 项目 / 本地任何设置文件（你的 bypassPermissions 不继承，租户改 settings 无效）；文件工具限制在工作空间；自带的 auto-memory 也被关闭。</td></tr>
<tr><td><code>--tools</code> 白名单 + <code>dontAsk</code></td><td>Claude Code</td><td>没有 SendMessage / ListAgents（借你的会话越权）、Skill、Cron 等；任何需要确认的操作直接拒绝。</td></tr>
<tr><td>OS 沙箱（macOS Seatbelt）</td><td>操作系统</td><td>Bash 只能读自己的工作空间和工具链、只能写工作空间、不能联网、连不上 broker socket、看不到进程列表。实测：其他租户、<code>~/.claude</code>、<code>~/.ssh</code>、人设目录全部 BLOCKED。</td></tr>
<tr><td>broker 强制</td><td>broker</td><td>会话身份按 sessionId 校验；只能回复自己用户的私聊；不能改路由、不能用管理接口；求助只能发给 <code>escalateTo</code> 里的人，每小时最多 5 次。</td></tr>
<tr><td>会话间通信与连接器</td><td>Claude Code 设置</td><td><code>crossSessionInbound: refuse</code>；不加载你 claude.ai 账号的连接器。</td></tr>
<tr><td>提示词放在租户够不着的地方</td><td>文件布局</td><td>人设和拼好的提示词在状态目录（0600），记忆在各自工作空间；文件名映射是单射，两个人不会共用。实测两个租户互相问不出对方人设。</td></tr>
</table>
<p>所有租户与你是<b>同一个 OS 用户</b>，以上是层层设防而不是硬隔离；租户能问出<b>自己</b>的人设和记忆。</p>

<h2>4. 状态在哪里</h2>
<table>
<tr><th>位置</th><th>内容</th><th>谁能碰</th></tr>
<tr><td><code>~/.claude/channels/dingtalk/config.json</code></td><td>钉钉凭证、<code>tenants</code> 配置（root、escalateTo、idleMinutes、model…）</td><td>你（0600）</td></tr>
<tr><td><code>access.json</code> · <code>routes.json</code></td><td>白名单 · 你手动绑定的路由</td><td>你</td></tr>
<tr><td><code>tenants.json</code></td><td>每个租户的工作空间、会话 id、最后活跃时间</td><td>broker</td></tr>
<tr><td><code>personas/&lt;staffId&gt;.md</code> · <code>default.md</code></td><td>人设（专属覆盖默认）</td><td>你（0600）</td></tr>
<tr><td><code>prompts/&lt;staffId&gt;.md</code></td><td>每次启动时拼好的「人设 + 记忆说明 + 记忆」</td><td>broker</td></tr>
<tr><td><code>debug.log</code></td><td>连接、路由、启动、回复事件；消息结构只记字段名和长度</td><td>你</td></tr>
<tr><td><code>dingtalk-tenants/&lt;staffId&gt;/</code></td><td><code>attachments/</code>、<code>.memory/MEMORY.md</code>、TA自己的文件</td><td>TA的会话、你（0700）</td></tr>
<tr><td><code>/Library/Application Support/ClaudeCode/managed-settings.json</code></td><td>批准 <code>dingtalk@remote-cc</code> 作为 channel（后台会话弹不出开发 channel 的确认框）</td><td>root</td></tr>
</table>

<h2>5. 生命周期</h2>
<ul>
<li><b>首条消息</b>：建工作空间 → 拼提示词 → <code>claude --bg</code> 启动 → shim 连上并通过校验 → 冲刷排队的消息。</li>
<li><b>空闲</b>：Claude Code 会在约 1 小时无活动后结束后台会话（实测）；broker 自己的 <code>idleMinutes</code> 回收是第二道。</li>
<li><b>再来消息</b>：<code>--resume</code> 续上同一段对话；若旧会话还没退干净，Claude Code 会续写成一个副本，broker 记下新 id 并清掉旧的。</li>
<li><b>人设与记忆</b>：每次启动时读入（<code>--system-prompt-snapshot off</code> 让续上的对话也拿到新版本）；会话运行中自己往 <code>MEMORY.md</code> 记东西，下次启动时带回。</li>
<li><b>连接</b>：每 20 秒 ping；45 秒没有 pong 就判定连接已死并重连 —— 实测换网络后 53 秒内自愈。</li>
<li><b>求助</b>：会话做不了的事用 <code>ask_owner</code> 发到你的私聊；单向，你在钉钉里的回复进的是你自己的会话。</li>
</ul>

<h2>6. 已知限制</h2>
<ul>
<li>同一个 OS 用户下的纵深防御，不是容器级隔离；不完全信任的租户应换成容器或独立 OS 用户。</li>
<li>所有租户共用你的 Claude Max 额度；可以用 <code>tenants.model</code> 让租户用更便宜的模型。</li>
<li>broker 还没有 launchd 托管：机器重启后不会自己起来，笔记本休眠时机器人离线 —— 计划迁到 Mac mini。</li>
<li>Channel 仍是 Claude Code 的 research preview；MCP SDK 锁在 1.29.0，以免新协议版本静默关掉 channel 推送。</li>
<li>群聊不在租户模式内，仍按 <code>/dingtalk:bind</code> 绑定到某个会话。</li>
</ul>
<footer>生成于 {datetime.date.today():%Y-%m-%d} · 对应代码：broker.ts / tenants.ts / server.ts / shared.ts · 实测数据来自 debug.log 与 test/tenant-smoke.ts</footer>
"""

page = f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>钉钉多租户 Claude Code · 架构</title><style>{CSS}</style></head><body><main>{body}</main></body></html>'
out = pathlib.Path(__file__).resolve().parent / 'multi-tenant-architecture.html'
out.write_text(page)
print(out, f'{len(page):,} bytes; sequence diagram height {height}')
