# Local Tool Bridge

让 ChatGPT / Codex 等 MCP 客户端调用你本机的工具 —— 读写文件、执行命令、发起 HTTP 请求 —— 全部经由一个你自己掌控的本地程序，并且每一次调用都可以被你审查和否决。

- **本地宿主（Rust）**：策略引擎、路径沙箱、工具实现、审计日志、MCP 端点。
- **控制面板（Rust + egui）**：原生窗口，无 WebView，跨平台。用于授权、配置策略、查看审计。
- **MCP 端点**：`http://127.0.0.1:<port>/mcp`，经 OpenAI Secure MCP Tunnel 接入 ChatGPT / Codex（见 [ChatGPT 接入（MCP）](#chatgpt-接入mcp) 与 [`docs/chatgpt-mcp.md`](docs/chatgpt-mcp.md)）。

---

## 架构

```
ChatGPT / Codex（Connector）
  │  MCP JSON-RPC（经 OpenAI 托管隧道）
  ▼
OpenAI Secure MCP Tunnel 控制面  ── 长轮询 ──►  tunnel-client（本机守护进程）
                                                  │  MCP Streamable HTTP + x-dlb-secret
                                                  ▼
                                    ltb-host（http://127.0.0.1:8789/mcp）
                                      Dispatcher：校验 → 策略 → 审批 → 执行
                                      工具：fs / shell / http
                                      审计日志（含被拒绝的调用）
                                                  │
                                    ltb-gui（egui 原生窗口）
                                      授权弹窗 / 策略编辑 / 审计查看
```

宿主还提供 HTTP 与 WebSocket 传输，供本地其他客户端使用（`ltb-host serve` / `serve-ws`）。

---

## 安全模型

### 令牌才是边界，Origin 不是

这一点容易搞错：

- CORS 是**读**控制，不是**执行**控制 —— 跨域简单请求照样会被送达并执行。
- MCP 端点的真正边界是共享令牌 `x-dlb-secret`：**每一个请求（包括 `initialize`）都校验它**。

Origin 检查只用于廉价地挡掉明显无关的网页，且显式容忍缺失 —— 它不能作为安全边界。

### 三层防护

1. **路径沙箱**：所有文件路径先规范化再校验，`..` 与符号链接都无法越出配置的工作目录。另有一份拒绝名单，即使工作目录设成了家目录，`.ssh`、`.env`、`*.pem` 之类也读不到。
2. **命令拒绝名单**：`rm -rf`、磁盘格式化、fork bomb 等**优先级高于任何规则**。即使你写了一条 `exec = 允许`，它们依然被拒绝 —— 因为一条能关掉它们的规则，迟早会被误写出来。
3. **私网拦截**：HTTP 工具默认拒绝环回、RFC1918、链路本地地址。这不只是洁癖：否则一次提示词注入，就可能让模型去读云环境的元数据端点（`169.254.169.254`）。重定向会逐跳重新校验，所以"公网 URL 302 到内网"这条路径也被堵住。

### 默认拒绝，而不是默认放行

策略判定为"需确认"但**没有任何人可以询问**时（比如只跑了 `ltb-host`、没开控制面板），调用会被**拒绝**。这条路径有专门的测试 `an_ask_verdict_fails_closed_when_no_human_is_available` 守着。

同理，控制面板窗口关闭后，审批器立刻切换为非交互状态，之后所有需要确认的调用都会被拒绝，而不是被默默放行。

---

## 快速开始

### 环境要求

Rust ≥ 1.77。

### 1. 构建

```bash
cd src && cargo build --release
```

产物：`src/target/release/ltb-gui`（控制面板）与 `ltb-host`（无界面宿主）。

### 2. 启动本地程序

直接运行控制面板（它内部会拉起 MCP 端点）：

```bash
./src/target/release/ltb-gui
```

或在无界面环境下只跑宿主：

```bash
./ltb-host serve-mcp        # MCP，默认 http://127.0.0.1:8789/mcp（ChatGPT 接入）
./ltb-host serve            # HTTP，默认 http://127.0.0.1:8788/rpc
./ltb-host serve-ws         # WebSocket
./ltb-host --print-secret   # 只打印令牌
```

宿主启动时会打印监听地址与令牌。令牌保存在：

- Windows `%APPDATA%\local-tool-bridge\config\secret`
- macOS `~/Library/Application Support/local-tool-bridge/secret`
- Linux `~/.config/local-tool-bridge/secret`

### 3. 配置工作目录（必做）

**默认策略下所有文件工具都会被拒绝**，因为还没有允许任何目录。在控制面板的「工具与策略」页添加工作目录，例如 `C:\Users\me\project`，然后点「保存策略」。

### 4. 接入 ChatGPT

见 [ChatGPT 接入（MCP）](#chatgpt-接入mcp) 与 [`docs/chatgpt-mcp.md`](docs/chatgpt-mcp.md)：在本机运行 `tunnel-client`，把 `MCP_SERVER_URL` 指到 MCP 端点，通过 `MCP_EXTRA_HEADERS` / `MCP_DISCOVERY_EXTRA_HEADERS` 携带 `x-dlb-secret`，再在 ChatGPT 设置里创建 Connector。

---

## ChatGPT 接入（MCP）

`ltb-host` 提供 **MCP（Model Context Protocol）端点**（`http://127.0.0.1:<port>/mcp`），让 ChatGPT / Codex 通过 OpenAI 官方的 **Secure MCP Tunnel**（`openai/tunnel-client`）调用本机工具。工具以 Codex 兼容的形式暴露：`read_file`、`list_dir`、`exec`、`unified_exec`、`apply_patch`（MCP 工具名与这里一致）。

```text
ChatGPT Connector → OpenAI 隧道服务 → tunnel-client（本机）→ ltb-host /mcp → 本地工具
```

启用方式（二选一）：

- **控制面板**：`./src/target/release/ltb-gui` 启动后自动提供 MCP 端点，「状态」页会显示 `MCP（ChatGPT）` 地址（通常 `http://127.0.0.1:8790/mcp`），审批弹窗随之可用。
- **无界面宿主**：`./src/target/release/ltb-host serve-mcp --mcp-port 8789`（默认 `--mcp-port 8789`）。

随后在本机运行 `tunnel-client`，把 `MCP_SERVER_URL` 指到上述地址，并通过 `MCP_EXTRA_HEADERS` / `MCP_DISCOVERY_EXTRA_HEADERS` 携带 `x-dlb-secret`（宿主打印的共享令牌），再在 ChatGPT 设置里创建 Connector。完整步骤、配置样例与故障排查见 **[`docs/chatgpt-mcp.md`](docs/chatgpt-mcp.md)**（含 `docs/tunnel-client.chatgpt.yaml` 样例）。

安全性：MCP 端点只绑定 `127.0.0.1`；每一个请求（包括 `initialize`）都校验共享令牌；策略、路径沙箱、命令拒绝名单、私网拦截对 MCP 调用完全生效；无审批窗口的 `serve-mcp` 对「需确认」工具 fail-closed。

---

## 内置工具

模型通过 MCP 只能看到 Codex 兼容的 5 个工具：

| 工具 | 默认权限 | 说明 |
| --- | --- | --- |
| `read_file` | 需确认 | 读取文本文件。默认带行号；传 `lineNumbers: false` 可拿到**逐字节一致**的原文。二进制文件会被拒绝而不是返回乱码。 |
| `list_dir` | 允许 | 列目录，可选递归与 glob 过滤。 |
| `exec` | 需确认 | 执行命令，捕获 stdout/stderr 与退出码。 |
| `unified_exec` | 需确认 | Codex unified-exec 兼容形式，schema 与 `exec` 相同。 |
| `apply_patch` | 需确认 | 应用 Codex 补丁格式（Add / Delete / Update / Move）。 |

每个工具都可以单独设为「允许 / 需确认 / 禁止」。

> **关于 `lineNumbers`**：带行号的视图每行输出一个 `\n`，因此无法保留 CRLF 或"文件末尾没有换行"这两个细节。如果模型打算读出来再写回去，应当使用 `lineNumbers: false` —— 那种模式下返回的是原文本身，没有任何前缀或改写。这条差异在实现里由 `split_inclusive('\n')` 保证（见下「其四」）。

---

## 项目结构

```
local-tool-bridge/
├── docs/                       # 集成文档
│   ├── chatgpt-mcp.md          # ChatGPT 接入（OpenAI Secure MCP Tunnel）完整指南
│   ├── mcp-servers.md          # 外部 stdio MCP 服务器接入
│   └── tunnel-client.chatgpt.yaml   # tunnel-client 配置样例
├── src/                        # Rust 工作区
│   └── crates/
│       ├── core/               # 策略引擎、路径沙箱、工具、审计、调度
│       ├── host/               # HTTP / WebSocket / MCP 传输
│       │   └── src/mcp.rs      # MCP Streamable HTTP 端点（ChatGPT 接入）
│       └── gui/                # egui 控制面板（含 MCP 状态显示）
└── scripts/                    # 端到端冒烟测试（驱动真实二进制、真实线协议）
    ├── smoke-http.mjs          # HTTP 传输：健康检查、令牌、Origin、真实调用
    └── smoke-mcp.mjs           # MCP 握手、server/discover、会话、工具发现、真实调用、失败形态
```

---

## 测试

```bash
# Rust：单元测试 + 调度器集成测试
cd src && cargo test

# 端到端：驱动真实二进制，走真实线协议（需先 cargo build）
node scripts/smoke-http.mjs          # 12 项：健康检查、令牌、Origin、真实调用
node scripts/smoke-mcp.mjs           # 28 项：MCP 握手、server/discover、会话、工具发现、真实调用、失败形态
```

`scripts/smoke-*.mjs` 值得单独说明：它们启动**真实的二进制**、使用**真实的线协议**通信，因此能抓到单元测试抓不到的边界错误。开发过程中它们确实抓到了 —— 见下。

---

## 开发笔记：测试抓到的三个真实缺陷

留在这里是因为它们说明了哪些地方最容易出错。

**其一：控制面板的中文全是豆腐块。** `eframe` 的 `default_fonts` 只带 Ubuntu-Light 与 NotoEmoji，两者都不含任何 CJK 字形，于是界面里每一个汉字都渲染成 `□`。这个缺陷的形态很有迷惑性：令牌、`127.0.0.1`、`read_file` 这类 ASCII 全部正常，只有中文坏掉 —— 看起来像控件坏了，而不是字体缺字。修复方式是首帧之前挂上一份系统中文字体（`src/crates/gui/src/fonts.rs`），并且**追加**到字体族末尾而不是替换：追加才能让英文沿用原本的排版度量，只对 Ubuntu 覆盖不到的字形回退。之所以用系统字体而不是内嵌，是因为内嵌一份 CJK 字体会让二进制膨胀 10–20 MB，对控制面板来说代价过高；找不到字体时程序照常启动，只是回到原来的样子。

**其二：审批链路从未被接通。** `request_approval` 注册了一个等待审批结果的通道，却**从未调用 `Approver`**。结果是控制面板的授权弹窗永远不会出现，每个"需确认"的调用都会干等满 180 秒然后被拒绝。单元测试全绿 —— 因为没有任何一个测试真正走完过带审批的完整调用。加上集成测试后立刻暴露：三个测试各挂起 60 秒以上。修复后 15 个测试在 0.14 秒内跑完。

**其三：`read_file` 会悄悄改写行尾。** 最初用 `str::lines()` 切分，它会吃掉 `\r\n` 里的 `\r`，也会给"末尾没有换行"的文件补一个。模型读一个 CRLF 文件再写回去，就会把整个文件的行尾改掉。改用 `split_inclusive('\n')` 保留原始终止符，并加了 `lineNumbers: false` 这个逐字节模式。

---

## 已知限制

- **Windows 路径的反斜杠仍是主要失败点。** 模型经常只写一个 `\`，而单个 `\` 在 JSON 里是非法转义（`\U` 不是合法转义序列），于是整条调用被判为格式错误、不会执行。临时办法是让模型改用正斜杠路径（`C:/Users/...`），它同样能被解析。
- **提示词注入是概率性的。** 一个被污染的长对话理论上可能诱导模型调用工具 —— 这正是默认策略要求确认、且破坏性操作不可放行的原因。
- **审计日志按大小轮转（8 MB）**，会丢弃最旧的一半。
- **控制面板的中文依赖系统中文字体。** 字体是从系统路径按候选列表加载的（Windows 上依次尝试微软雅黑、黑体、宋体、等线），内嵌字体被刻意排除以控制体积。系统里一个候选都没有时，程序仍会启动，只是中文会退回成 `□`，并在日志里留下一条 `no CJK font found` 警告。

## 许可

MIT
