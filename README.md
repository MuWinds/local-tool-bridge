# Local Tool Bridge

让各种 LLM 网页端能够调用你本机的工具 —— 读写文件、执行命令、发起 HTTP 请求 —— 全部经由一个你自己掌控的本地程序，并且每一次调用都可以被你审查和否决。

ChatGPT / Codex 也可以经 **OpenAI Secure MCP Tunnel**（MCP 协议）接入同一套工具、策略与审批，见 [ChatGPT 接入（MCP）](#chatgpt-接入mcp)。

- **Chrome 扩展（TypeScript）**：在页面内注入工具契约、解析模型的工具调用、把结果回传。
- **本地宿主（Rust）**：策略引擎、路径沙箱、工具实现、审计日志。
- **控制面板（Rust + egui）**：原生窗口，无 WebView，跨平台。用于授权、配置策略、查看审计。

---

## 为什么是这样设计的

这套架构不是凭直觉选的，而是由四条实测结论决定的。它们解释了为什么某些看似显然的做法行不通。

### 1. 网页端不支持原生 function calling，所以只能走提示词注入

DeepSeek 网页版的后端**根本没有 `tools` 字段**。发过去的请求体只有：

```json
{
  "chat_session_id": "...",
  "parent_message_id": null,
  "model_type": "default",
  "prompt": "用户这一轮说的话",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": false,
  "action": null,
  "preempt": false
}
```

注意这是一个**扁平的字符串 `prompt`**，没有 OpenAI 风格的 `messages` 数组，也没有 system role。往里面塞 `tools` 会被静默忽略 —— 模型不会报错，只会开始胡编"我无法调用这个工具"。

所以工具契约必须作为**文本**教给模型，再由扩展从回复里解析出来。本项目的做法是裸 XML 标签：

```xml
<fs_read_file>{"path": "C:\\Users\\me\\notes.txt"}</fs_read_file>
```

用工具名直接当标签名，而不是 `<tool_call><invoke name="...">` 这类包装形式 —— 后者会显著降低模型的遵循率。

### 2. 工具契约必须"双位置"放置，否则几乎必然失败

这是整个项目里性价比最高的一条经验，来自对同类集成的实测：

| 契约放置方式 | 成功调用 |
| --- | --- |
| 只放在 prompt 最前面 | **0 / 3** |
| 前面放完整契约 **+ 末尾追加一句提醒** | **16 / 17** |

只前置一次，等到模型真正开始生成时，那段指令已经在几千 token 之外了，基本不起作用。所以 `buildSystemPrompt()` 产出完整契约，`buildReminder()` 产出一句话提醒，两者**必须一起用**。代码里两个函数的注释都写明了这一点。

### 3. 由扩展的 Service Worker 独占本地通道，是架构必然而非优化

Chrome 142 引入的 **Local Network Access** 规定：公网页面请求环回地址（`127.0.0.1`）需要用户授权，Chrome 147 起 WebSocket 也被纳入。而 Chrome 官方明确说明，**持有相应 `host_permissions` 的扩展 Service Worker 豁免**。

推论有三条：

- 页面的主世界脚本已经无法可靠地直连 `127.0.0.1`。
- content script 也不行 —— 它发的是页面的 Origin，受同源策略与 CORS 约束，`host_permissions` 对它无效。
- **只有 Service Worker 能承担这个角色。**

同样因为 MV3 的 Service Worker 会被随时回收，常驻 WebSocket 是被官方点名的反模式（它会阻止 worker 休眠）。所以默认传输是**请求/响应式的 HTTP**，WebSocket 仅作为需要服务端推送时的备选。

### 4. 证明（PoW）不绑定请求体，所以改写 prompt 是安全的

网页端每次发消息前都会先求一个 `x-ds-pow-response`（`DeepSeekHashV1`，本质是 SHA3 nonce 碰撞）。好消息是它只绑定**目标路径与时间窗**，不绑定请求体内容。

这意味着扩展可以放心地改写 `prompt` 字段，而页面已经算好的那个头依然有效。我们完全不需要重新实现那套 WASM。

另外，请求头里的 `x-hif-leim`（混淆 JS 生成的签名）与 `x-client-*` 指纹头，由页面自己生成并原样透传即可 —— 既不用逆向，也不会因为版本陈旧而被判定为爬虫。

---

## 架构

```
chat.deepseek.com
  ├─ MAIN world 脚本        ← 劫持 window.fetch，改写 prompt，解析 SSE
  │    │ window.postMessage（带标签的信封）
  ├─ ISOLATED content script ← 中转：页面世界 ⇄ 扩展世界
  │    │ chrome.runtime.sendMessage
  └─ Service Worker          ← 独占本地通道，唯一的出网口
       │
       ├─ HTTP  ws://127.0.0.1:8788/rpc   （默认，LNA 豁免）
       ├─ WebSocket                       （需要推送时）
       └─ Native Messaging                （Chrome 直接启动，无需令牌）
            │
       ┌────▼─────────────────────────────────┐
       │  ltb-host（Rust）                     │
       │   Dispatcher：校验 → 策略 → 审批 → 执行 │
       │   工具：fs / shell / http              │
       │   审计日志（含被拒绝的调用）             │
       └────┬─────────────────────────────────┘
            │
       ltb-gui（egui 原生窗口）
        授权弹窗 / 策略编辑 / 审计查看
```

### 为什么解析器要区分 THINK 与 RESPONSE

网页端的 SSE 不是 OpenAI 的 `choices[].delta`，而是一套自定义的 patch 协议：

```
data: {"p":"response/fragments","o":"APPEND","v":[{"type":"THINK","content":"让我想想"}]}
data: {"p":"response/fragments/-1/content","o":"APPEND","v":"…"}
data: {"v":"…"}                          ← 裸追加，继承"当前"分片
data: {"p":"response/status","v":"FINISHED"}
```

**陷阱在于：思维链与正式回答复用同一条 patch 路径。** 一个不带 `p` 的裸 `{"v":"…"}` 会追加到"当前打开的那个分片"，所以如果不用状态机记录当前分片类型，推理过程就会被混进回答里 —— 而工具调用**绝不能**从推理文本里解析，否则模型只是在"想"要调用什么，就会被真的执行。

`DeepSeekStreamDecoder` + `AnswerAccumulator` 就是干这个的：只有 `response` 通道的内容才会被送去匹配工具标签。

另外两个已处理的细节：`FINISHED` 之后仍可能有 `search_results`，所以不能见 `FINISHED` 就关流；结束判定同时接受 `response/status=FINISHED`、批量形式里的 `quasi_status=FINISHED` 和 `[DONE]`。

---

## 安全模型

### 令牌才是边界，Origin 不是

这一点容易搞错：

- CORS 是**读**控制，不是**执行**控制 —— 跨域简单请求照样会被送达并执行。
- 扩展 Service Worker 请求 `host_permissions` 内的地址时被视为同源，**可能根本不带 `Origin` 头**。

所以 Origin 白名单不能作为安全边界：按"缺失 Origin 就拒绝"会把主要客户端挡在门外，而"有 Origin 就放行"证明不了任何事。**真正的边界是共享令牌。** 代码里的 Origin 检查只用于廉价地挡掉明显无关的网页，且显式容忍缺失。

### 三层防护

1. **路径沙箱**：所有文件路径先规范化再校验，`..` 与符号链接都无法越出配置的工作目录。另有一份拒绝名单，即使工作目录设成了家目录，`.ssh`、`.env`、`*.pem` 之类也读不到。
2. **命令拒绝名单**：`rm -rf`、磁盘格式化、fork bomb 等**优先级高于任何规则**。即使你写了一条 `shell.exec = 允许`，它们依然被拒绝 —— 因为一条能关掉它们的规则，迟早会被误写出来。
3. **私网拦截**：`http.request` 默认拒绝环回、RFC1918、链路本地地址。这不只是洁癖：否则网页里的一次提示词注入，就可能让模型去读云环境的元数据端点（`169.254.169.254`）。重定向会逐跳重新校验，所以"公网 URL 302 到内网"这条路径也被堵住。

### 默认拒绝，而不是默认放行

策略判定为"需确认"但**没有任何人可以询问**时（比如只跑了 `ltb-host`、没开控制面板），调用会被**拒绝**。这条路径有专门的测试 `an_ask_verdict_fails_closed_when_no_human_is_available` 守着。

同理，控制面板窗口关闭后，审批器立刻切换为非交互状态，之后所有需要确认的调用都会被拒绝，而不是被默默放行。

---

## 快速开始

### 环境要求

Node ≥ 20、pnpm ≥ 10、Rust ≥ 1.77、Chrome ≥ 116。

### 1. 构建

```bash
pnpm install
pnpm build:protocol          # 共享协议包
pnpm build:extension         # 生成 apps/extension/dist
cd apps/desktop && cargo build --release
```

产物：`apps/desktop/target/release/ltb-gui`（控制面板）与 `ltb-host`（无界面宿主）。

### 2. 启动本地程序

直接运行控制面板（它内部会拉起全部传输）：

```bash
./apps/desktop/target/release/ltb-gui
```

或在无界面环境下只跑宿主：

```bash
./ltb-host serve            # HTTP，默认 http://127.0.0.1:8788/rpc
./ltb-host serve-ws         # WebSocket
./ltb-host serve-mcp        # MCP，默认 http://127.0.0.1:8789/mcp（ChatGPT 接入）
./ltb-host native           # Native Messaging（由 Chrome 启动）
./ltb-host --print-secret   # 只打印令牌
```

宿主启动时会打印监听地址与令牌。令牌保存在：

- Windows `%APPDATA%\local-tool-bridge\config\secret`
- macOS `~/Library/Application Support/local-tool-bridge/secret`
- Linux `~/.config/local-tool-bridge/secret`

### 3. 加载扩展

1. 打开 `chrome://extensions`，开启右上角**开发者模式**。
2. 点击**加载已解压的扩展程序**，选择 `apps/extension/dist`。
3. 点扩展图标，把令牌粘进去（HTTP/WebSocket 需要；Native Messaging 不需要）。
4. 打开 <https://chat.deepseek.com> 刷新页面。

### 4. 配置工作目录（必做）

**默认策略下所有文件工具都会被拒绝**，因为还没有允许任何目录。在控制面板的「工具与策略」页添加工作目录，例如 `C:\Users\me\project`，然后点「保存策略」。

HTTP 工具同理，需要在白名单里添加域名。

### 5. 使用

直接让 DeepSeek 做事即可，例如：

> 读一下 C:\Users\me\project\README.md，总结一下这个项目是干什么的。

模型会输出一个 `<fs_read_file>…</fs_read_file>` 标签。扩展解析后请求宿主执行，控制面板会弹出授权框 —— 可以选「仅本次允许」「始终允许」（会写入一条限定在该目录的规则）或「拒绝」。

### 6. 界面上的痕迹会被自动清理

网页端会把**它实际发出的整个 prompt** 原样渲染回用户气泡里，所以不做处理的话，你会看到自己那条消息里塞满了工具契约，而工具结果那一轮则是一整屏 `<tool_result>` XML。扩展会把它们删掉，只留下你真正打的那句话。

这里有个关键约束：**注入的文本和你自己的话在同一个文本节点里**，所以 CSS 选择器无法把两者分开 —— 任何"隐藏这个气泡"的规则都会连你的问题一起隐藏。因此这段文本是在文本层面就地删除的，CSS 只负责隐藏"删完之后变空"的那类气泡。

思考区（深度思考）里如果出现了工具标签，同样会被删掉。那个标签本来就是**不会被执行**的（解析器只扫 `response` 通道，从不扫思考通道），删掉只是为了避免看起来像泄漏。

正式回答里的工具标签**不再原样显示**，而是渲染成一张卡片：

```text
▸ fs.list_dir  已提交本机执行
│ path: "C:\\Users\\me\\proj"  maxEntries: 200
```

工具结果那一轮同理，渲染成结果卡片（`◂ shell.exec  执行结果` / `│ …`），而不是被整轮删掉。三条规则各有原因，都是实测踩出来的：

- **删除范围不能碰 `<tool_result>` 块。** 结果那一轮是内容而不是管道。而且删除 `<tool_result>` 块本身还不够 —— 只删末尾那句"以上是本机工具的执行结果…"时，删除范围会顺着空行**向上吞掉整个块**（`expandOverSeparatorLines` 的合并行为），结果气泡变空、随后被 CSS 隐藏，看起来就是"工具结果整轮消失"。所以内容脚本请求删除时带 `keepToolResults: true`，块与那句 footer 都留给渲染器处理。
- **一个容器链上只能渲染一次。** 一条消息会命中 `.ds-message`、`.ds-markdown`、`.ds-think-content` 三个选择器，它们是嵌套的。最初把"已渲染"标记打在**每一层**容器上，CSS 于是把内边距和背景画了三遍（实测是一条双线边框）。现在标记只打在卡片元素（`<span>`）上，选择器要求它同时是最内层，见 `CARD_SELECTOR`。
- **标签与卡片字符不能跨通道传染。** 从消息根节点扫描时会连带看到思考区的文本，于是思考区里的标签会被"渲染成卡片"并留在思考面板里。卡片渲染器因此显式跳过 `.ds-think-content` 里的节点。

相关实现：`packages/protocol/src/scrub.ts`（纯字符串逻辑）、`packages/protocol/src/present.ts`（卡片渲染，同样纯字符串、可单测）与 `apps/extension/src/content/scrubber.ts`（DOM 层）。

> **调度上的一个坑（已修）**：这一层原来只在 `requestAnimationFrame` 里跑，而且 `scheduled` 标志在扫描**之前**就被清掉。结果是 (a) 页面隐藏时 rAF 可能完全停摆，后台标签页回来后整段对话是生的；(b) 扫描里抛一次异常就把标志永久留在"已排队"状态，整个表现层静默失效 —— 症状和"扩展没装上"一模一样。现在用令牌（token）保证同一次调度只跑一遍，rAF 之外还有超时兜底，并每 2 秒检查一次 `document.documentElement` 是否被换掉（SPA 导航会静默孤立 observer）。

---

## 三种传输方式

| | HTTP（默认） | WebSocket | Native Messaging |
| --- | --- | --- | --- |
| 需要令牌 | 是 | 是 | 否（Chrome 校验扩展 ID） |
| 需要注册 | 否 | 否 | 是（注册表 / plist） |
| LNA 影响 | 扩展豁免 | Chrome 147 起纳入 | 不受影响 |
| Service Worker | 可正常休眠 | 长连接会阻止休眠 | 可正常休眠 |
| 单条消息上限 | 无 | 无 | 宿主→浏览器 1 MB |
| 适用场景 | **默认** | 需要服务端推送 | 打包发布、最高安全性 |

Native Messaging 的注册可以在控制面板的「安装」页一键完成，它会写入正确的清单并登记注册表（Windows）/ plist 路径（macOS/Linux）。

> **注意**：Native Messaging 的两个方向上限不同 —— 浏览器→宿主 64 MB，宿主→浏览器 1 MB。写反是很常见的错误，代码里 `MAX_INBOUND_BYTES` 与 `MAX_OUTBOUND_BYTES` 是两个独立的常量，并有测试守着。

---

## ChatGPT 接入（MCP）

`ltb-host` 另有一个 **MCP（Model Context Protocol）端点**（`http://127.0.0.1:<port>/mcp`），让 ChatGPT / Codex 通过 OpenAI 官方的 **Secure MCP Tunnel**（`openai/tunnel-client`）调用与 DeepSeek 扩展**完全相同**的工具、策略、审批与审计。工具以 MCP 安全的形式暴露（点号替换为下划线：`fs_read_file`、`fs_list_dir`、`fs_search`、`fs_write_file`、`shell_exec`、`http_request`）。

```text
ChatGPT Connector → OpenAI 隧道服务 → tunnel-client（本机）→ ltb-host /mcp → 同一套工具
```

启用方式（二选一）：

- **控制面板**：`./apps/desktop/target/release/ltb-gui` 启动后自动提供 MCP 端点，「状态」页会显示 `MCP（ChatGPT）` 地址（通常 `http://127.0.0.1:8790/mcp`），审批弹窗随之可用。
- **无界面宿主**：`./apps/desktop/target/release/ltb-host serve-mcp --mcp-port 8789`（默认 `--mcp-port 8789`）。

随后在本机运行 `tunnel-client`，把 `MCP_SERVER_URL` 指到上述地址，并通过 `MCP_EXTRA_HEADERS` / `MCP_DISCOVERY_EXTRA_HEADERS` 携带 `x-dlb-secret`（与扩展共用的共享令牌），再在 ChatGPT 设置里创建 Connector。完整步骤、配置样例与故障排查见 **[`docs/chatgpt-mcp.md`](docs/chatgpt-mcp.md)**（含 `docs/tunnel-client.chatgpt.yaml` 样例）。

安全性：MCP 端点只绑定 `127.0.0.1`；每一个请求（包括 `initialize`）都校验共享令牌；策略、路径沙箱、命令拒绝名单、私网拦截对 MCP 调用完全生效；无审批窗口的 `serve-mcp` 对「需确认」工具 fail-closed。

---

## 内置工具

| 工具 | 默认权限 | 说明 |
| --- | --- | --- |
| `fs.read_file` | 需确认 | 读取文本文件。默认带行号；传 `lineNumbers: false` 可拿到**逐字节一致**的原文。二进制文件会被拒绝而不是返回乱码。 |
| `fs.list_dir` | 允许 | 列目录，可选递归与 glob 过滤。 |
| `fs.search` | 允许 | 正则搜索文件内容，返回行号。自动跳过 `.git`、`node_modules`。 |
| `fs.write_file` | 需确认 | 写入 / 追加 / 仅创建。 |
| `shell.exec` | 需确认 | 执行命令，捕获 stdout/stderr 与退出码。 |
| `http.request` | 需确认 | HTTP 请求，仅限白名单域名。 |

每个工具都可以单独设为「允许 / 需确认 / 禁止」。

> **关于 `lineNumbers`**：带行号的视图每行输出一个 `\n`，因此无法保留 CRLF 或"文件末尾没有换行"这两个细节。如果模型打算读出来再写回去，应当使用 `lineNumbers: false` —— 那种模式下返回的是原文本身，没有任何前缀或改写。这条差异由 `scripts/smoke-binary-mode.mjs` 的 8 个逐字节用例守着。

---

## 项目结构

```
local-tool-bridge/
├── docs/                       # 集成文档
│   ├── chatgpt-mcp.md          # ChatGPT 接入（OpenAI Secure MCP Tunnel）完整指南
│   └── tunnel-client.chatgpt.yaml   # tunnel-client 配置样例
├── packages/protocol/          # 共享协议：JSON-RPC、工具目录、注入提示词、SSE 解析器、界面清理与卡片渲染
├── apps/extension/             # Chrome MV3 扩展
│   └── src/
│       ├── main-world/         # 页面世界的 fetch 劫持与流解析
│       ├── content/            # ISOLATED 中转、页面指示器、授权弹窗、注入文本清理
│       ├── background/         # Service Worker、三种传输
│       ├── popup/              # 扩展设置面板
│       └── shared/             # 设置持久化、页面消息协议
├── apps/desktop/               # Rust 工作区
│   └── crates/
│       ├── core/               # 策略引擎、路径沙箱、工具、审计、调度
│       ├── host/               # HTTP / WebSocket / Native Messaging / MCP 传输
│       │   └── src/mcp.rs      # MCP Streamable HTTP 端点（ChatGPT 接入）
│       └── gui/                # egui 控制面板（含 MCP 状态显示）
└── scripts/                    # 端到端冒烟测试与浏览器侧验证
    ├── smoke-*.mjs             # 真实二进制、真实线协议（含 smoke-mcp.mjs：MCP 握手/工具调用/会话）
    ├── load-extension.mjs      # CDP 加载未打包扩展（--load-extension 已失效）
    ├── restart-chrome.mjs      # 重启调试浏览器并重新装载扩展（改完 dist 后用它）
    ├── extensions-report.mjs   # 读 chrome://extensions 的真实状态（是否被停用）
    ├── configure-extension.mjs # 免点击写入令牌
    ├── check-page.mjs          # 刷新并确认内容脚本生效
    ├── drive-conversation.mjs  # 驱动一次真实对话
    ├── verify-presentation.mjs # 在扩展自己的页面里跑内容脚本，断言卡片渲染
    └── verify-scrub*.mjs       # 注入文本清理的字符串 / 真实 DOM 验证
```

### 改了 `dist` 之后怎么让浏览器用上

**刷新页面是不够的。** 内容脚本只在扩展**被装载**时读一次，所以改完 `apps/extension/dist` 之后：

- `chrome.runtime.reload()` 是**陷阱**：Chrome 153 上它可能把非商店扩展变成**已停用**，而扩展页的开关是灰的、`Extensions.loadUnpacked` 也无法再启用它。唯一的出路是重启浏览器（并且要先在 `chrome://extensions` 打开开发者模式）。
- 正确做法是 `node scripts/restart-chrome.mjs`：它会照抄当前调试浏览器的启动参数、干净退出、重新启动并装载扩展。想确认状态就用 `node scripts/extensions-report.mjs`，它会直接打印 `#card` 是否带 `disabled`。
- 只想在**扩展自己的页面**里验证表现层（不需要登录、不碰你的对话）用：

  ```bash
  chrome --remote-debugging-port=9250 --user-data-dir=<临时profile> \
         --enable-unsafe-extension-debugging --no-first-run --no-default-browser-check about:blank
  CDP_PORT=9250 node scripts/load-extension.mjs apps/extension/dist
  CDP_PORT=9250 node scripts/verify-presentation.mjs
  ```

  这个 fixture 自己造一份与真实转录同构的 DOM，覆盖六个用例：注入契约被删、纯调用轮渲染成卡片、有正文的调用轮、代码块里的标签保持原样、思考区标签被删、工具结果轮渲染成结果卡片。

> **为什么不在真实页面上做合成测试**：真实页面里 DOM 由页面自己的 JS realm 创建，而内容脚本跑在另一个 realm。用页面 realm 造出来的合成消息，观测行为与脚本自己造的不一致（实测出现过"诊断说这一轮从未被访问，DOM 却显示它已被清空"这种自相矛盾）。fixture 里两者同属一个 realm，没有这个干扰。

---

## 测试

```bash
# TypeScript：协议解析器、模糊匹配、SSE 解码器、卡片渲染
pnpm build:protocol && node --test packages/protocol/test/*.test.mjs

# Rust：单元测试 + 调度器集成测试
cd apps/desktop && cargo test

# 端到端：驱动真实二进制，走真实线协议
node scripts/smoke-native.mjs        # 15 项：握手、工具调用、路径越界、拒绝名单
node scripts/smoke-http.mjs          # 12 项：健康检查、令牌、Origin、真实调用
node scripts/smoke-binary-mode.mjs   # 17 项：换行符与多字节字符的逐字节完整性
node scripts/smoke-mcp.mjs           # 28 项：MCP 握手、server/discover、会话、工具发现、真实调用、失败形态

# 浏览器侧：表现层（卡片 / 清理 / 隐藏）的七个断言，见下方「改了 dist 之后…」
CDP_PORT=9250 node scripts/verify-presentation.mjs
```

`scripts/smoke-*.mjs` 值得单独说明：它们启动**真实的二进制**、使用**真实的 Chrome 帧格式**通信，因此能抓到单元测试抓不到的边界错误。开发过程中它们确实抓到了 —— 见下。

### 在页面里验证（浏览器侧）

```bash
node scripts/verify-scrub.mjs        # 纯字符串：用真实契约与真实 tool_result 文本
node scripts/verify-scrub-live.mjs   # 真实 DOM：确认注入文本被删、思考区标签被删
node scripts/drive-conversation.mjs "<消息>"   # 驱动一次真实对话
```

#### 加载扩展到测试用 Chrome（`--load-extension` 已失效）

**Chrome 137 起 `--load-extension` 命令行开关被移除。** 它不会报错，只是**静默失效** —— 表现和"扩展构建失败"完全一样（没有 target、页面里没有注入痕迹），非常容易往错误方向排查。

替代方案是 CDP 的 `Extensions.loadUnpacked`，但**前提是浏览器以 `--enable-unsafe-extension-debugging` 启动**，否则该命令会被拒绝。完整流程：

```bash
# 1. 启动一个带调试端口的 Chrome（用独立 profile，不要动你自己的）
chrome --remote-debugging-port=9222 \
       --user-data-dir=<测试 profile> \
       --enable-unsafe-extension-debugging \
       --no-first-run --no-default-browser-check \
       https://chat.deepseek.com/

# 2. 通过 CDP 加载未打包扩展（返回扩展 id）
node scripts/load-extension.mjs apps/extension/dist

# 3. 把令牌写进扩展存储，省去手点 popup
node scripts/configure-extension.mjs <令牌> [端口]

# 4. 刷新页面并确认扩展真的生效了
node scripts/check-page.mjs
```

`load-extension.mjs` 连接的是 **browser 级** endpoint（`/json/version`），而不是 page endpoint —— `Extensions.loadUnpacked` 是浏览器级命令，连错端点会失败。`configure-extension.mjs` 则连扩展自己的 target，因为 `chrome.storage.local` 在那里。

**为什么必须刷新页面：** 内容脚本在 `document_start` 注入，只对扩展注册**之后**新开的文档生效。浏览器启动时就在打开的那个页面不会被注入，所以加载扩展后必须 `Page.reload`（`check-page.mjs` 会自动做这件事）。

**MV3 的 Service Worker 会休眠**，所以它**不一定**出现在 `/json/list` 里。看不到扩展 target ≠ 扩展没加载；判断依据应该是页面里的注入痕迹：

```js
window.__dlbDebug        // 主世界 hook 是否装好
document.getElementById('__dlb_scrub_styles__')   // 内容脚本是否跑过
```

> 顺带一条排查经验：`--load-extension` 失效时，`chrome://extensions` 里**不会**出现任何错误条目 —— 因为扩展压根没被尝试加载。别在那里找报错，直接看页面里有没有 `__dlbDebug`。

---

## 开发笔记：测试抓到的四个真实缺陷

留在这里是因为它们说明了哪些地方最容易出错。

**其一：控制面板的中文全是豆腐块。** `eframe` 的 `default_fonts` 只带 Ubuntu-Light 与 NotoEmoji，两者都不含任何 CJK 字形，于是界面里每一个汉字都渲染成 `□`。这个缺陷的形态很有迷惑性：令牌、`127.0.0.1`、`fs.read_file` 这类 ASCII 全部正常，只有中文坏掉 —— 看起来像控件坏了，而不是字体缺字。修复方式是首帧之前挂上一份系统中文字体（`apps/desktop/crates/gui/src/fonts.rs`），并且**追加**到字体族末尾而不是替换：追加才能让英文沿用原本的排版度量，只对 Ubuntu 覆盖不到的字形回退。之所以用系统字体而不是内嵌，是因为内嵌一份 CJK 字体会让二进制膨胀 10–20 MB，对控制面板来说代价过高；找不到字体时程序照常启动，只是回到原来的样子。

**其二：审批链路从未被接通。** `request_approval` 注册了一个等待扩展回答的通道，却**从未调用 `Approver`**。结果是控制面板的授权弹窗永远不会出现，每个"需确认"的调用都会干等满 180 秒然后被拒绝。单元测试全绿 —— 因为没有任何一个测试真正走完过带审批的完整调用。加上集成测试后立刻暴露：三个测试各挂起 60 秒以上。修复后 15 个测试在 0.14 秒内跑完。

**其三：Native Messaging 的信任模型搞错了。** 最初要求 Native Messaging 也提供共享令牌，但 Chrome **从不发送**这个令牌 —— 它通过"只启动清单里登记的宿主"来完成认证。于是这条传输永远无法完成握手。修复方式是把信任判断交给**传输层**声明（`PeerTrust::Verified` / `Untrusted`），而不是由消息内容自证。

**其四：`fs.read_file` 会悄悄改写行尾。** 最初用 `str::lines()` 切分，它会吃掉 `\r\n` 里的 `\r`，也会给"末尾没有换行"的文件补一个。模型读一个 CRLF 文件再写回去，就会把整个文件的行尾改掉。改用 `split_inclusive('\n')` 保留原始终止符，并加了 `lineNumbers: false` 这个逐字节模式。

顺带澄清一个**不适用**的担忧：Windows 上 C 运行时的文本模式会把 `\n` 改写成 `\r\n`，从而破坏长度前缀、让整个通道永久失步 —— 这是 Native Messaging 最经典的故障。本项目不受影响（Rust 的标准库直接做二进制 I/O，不经过那个转换层），但这属于"必须实测而非假设"的结论，所以 `smoke-binary-mode.mjs` 里有一项专门断言帧缓冲没有残留字节。

---

## 已知限制

- **只支持 `chat.deepseek.com`**。选择器与接口形态都针对该站点，上游改版可能导致失效。
- **模型不总是遵循工具语法。** 双位置放置把成功率提到很高，但不是 100%。解析器带容错（JSON 修复、工具名模糊匹配、信封白名单），仍无法覆盖所有情况。
- **Windows 路径的反斜杠仍是主要失败点。** 提示词明确要求写成 `\\`，但模型经常只写一个 `\`，而单个 `\` 在 JSON 里是非法转义（`\U` 不是合法转义序列），于是整条调用被判为格式错误、不会执行 —— 页面上看起来就像"标签没生效"。这是一个已确认的真实缺陷，尚未修复；临时办法是让模型改用正斜杠路径（`C:/Users/...`），它同样能被解析。
- **提示词注入是概率性的。** 一个被污染的长对话理论上可能诱导模型调用工具 —— 这正是默认策略要求确认、且破坏性操作不可放行的原因。
- **`nativeToolsMode` 开关保留但无效。** 它对应"注入原生 `tools` 参数"这条路线，而上游会静默忽略。留作开关仅仅是为了应对上游将来可能改变行为。
- 审计日志按大小轮转（8 MB），会丢弃最旧的一半。
- **控制面板的中文依赖系统中文字体。** 字体是从系统路径按候选列表加载的（Windows 上依次尝试微软雅黑、黑体、宋体、等线），内嵌字体被刻意排除以控制体积。系统里一个候选都没有时，程序仍会启动，只是中文会退回成 `□`，并在日志里留下一条 `no CJK font found` 警告。
- **卡片是"文本 + CSS"，不是真正的 DOM 组件。** 转录由 React 的虚拟列表持有，而 React 把文本节点当作位置标记：把文本节点换成元素会让下一次渲染抛 `insertBefore` 错误并留下孤儿节点。所以卡片只是改了文本节点的内容，再用注入的样式表把它画成卡片。代价有两条：
  - 卡片文字**不可选中**（`user-select: none`）。React 重写文本节点时，落在其中的选区会让渲染报错，所以选择被主动禁掉了。
  - 样式依赖一个 CSS-module 哈希类名（`.fbb737a4`，用于把结果气泡从聊天气泡改成卡片外形）。这类哈希会随上游改版消失；消失的后果只是外形退回气泡，卡片本身照常渲染。

## 许可

MIT
