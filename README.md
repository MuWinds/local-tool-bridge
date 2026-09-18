# Local Tool Bridge

让 ChatGPT / Codex 安全地使用你电脑上的工具——读写文件、执行命令、发起 HTTP 请求。一切经由本地控制面板：每次调用都可以先看再批，全程留痕。

- **控制面板（ltb-gui）**：原生桌面窗口，启动即用。授权、策略、审计、接入 ChatGPT 都在这里完成。
- **内置服务与隧道**：MCP / HTTP / WebSocket 端点与 ChatGPT 安全隧道全部内置，无需另装任何客户端程序。
- **可选 Direct Remote MCP**：保留 Tunnel 默认路径；公网模式可选 Static Bearer、OAuth 2.1 + PKCE，或高熵 Secret Path（No Auth），并可配合 Caddy 提供 HTTPS。

---

## 快速开始（3 步）

### 第 0 步：构建

需要 Rust ≥ 1.88：

```bash
cd src && cargo build --release
```

产物为 `src/target/release/ltb-gui`（控制面板）与 `ltb-host`（无界面服务）。

> 代码风格遵循 [Rust Style Guide](https://doc.rust-lang.org/style-guide/) 的 Rust 2024
> style edition（见 `src/rustfmt.toml`）。`cargo fmt` 需要 Rust ≥ 1.94（rustfmt 1.9.0
> 起才支持 `style_edition = "2024"`），编译本身仍只需 ≥ 1.88。

### 第 1 步：启动控制面板

```bash
./src/target/release/ltb-gui
```

窗口打开即代表本地服务已就绪（顶部显示「● 运行中」）。关闭窗口后，需要人工确认的调用会被一律拒绝，不会悄悄放行。

> 控制面板同时只能运行一个实例；重复启动会提示"已运行"。

### 第 2 步：添加工作目录

默认策略下，模型读不到、也改不了你电脑上的任何文件。打开「**工具与策略**」页：

1. 在工作目录区域点「选择文件夹…」，选一个你允许模型访问的文件夹（例如你的项目目录）；
2. 点「保存策略」。

想进一步放开，可在同一页调整每个工具的权限（允许 / 需确认 / 禁止）、默认 Shell、HTTP 白名单等。

### 第 3 步：接入 ChatGPT

在「**安装 / MCP**」页：

1. 填 OpenAI 平台创建的 **Tunnel ID**；
2. 粘贴 **Runtime API Key** 并点「保存 Tunnel API Key」；
3. 勾选「启动 GUI 时自动运行 Rust Tunnel」并点「保存 Tunnel 配置」；
4. 在 ChatGPT 设置里新建 Connector，选择你的 Tunnel、扫描工具，即可开始使用。

详细步骤见 [让 ChatGPT 使用 Local Tool Bridge](docs/chatgpt-mcp.md)。有公网 IP / 域名并希望绕过 Tunnel 的用户，可看 [Direct Remote MCP 与 Caddy](docs/direct-mcp.md)。

---

## 控制面板（ltb-gui）使用指南

窗口顶部是四个页签，右上角显示服务运行状态，底部显示操作提示。需要确认的工具调用会在窗口中央弹出审批框。

### 状态

启动后第一眼看到的就是它：

- 各项服务的地址（HTTP / WebSocket / MCP）与 **Secure MCP Tunnel** 是否在运行；
- **连接令牌**——其他客户端连到本机服务时需要的口令，可一键复制；
- 当前策略概览：多少工具允许 / 需确认 / 禁止，以及是否已设置工作目录和 HTTP 白名单。

### 工具与策略

管理"模型能做什么"：

- **工具权限**：`read_file`、`list_dir`、`exec`、`unified_exec`、`apply_patch` 五个工具，逐个设为允许 / 需确认 / 禁止；
- **默认 Shell**：模型执行命令时用哪个终端（Windows 可选 PowerShell / Git Bash / WSL / 命令提示符）；
- **工作目录**：添加 / 移除模型可访问的文件夹；
- **HTTP 白名单**：模型可以访问哪些网站（如 `api.github.com`），默认禁止访问本机与局域网地址，可勾选放开；
- 修改后记得点「保存策略」。

### 审计日志

每一次工具调用的流水账：时间、工具、结果（允许 / 已批准 / 已拒绝 / 用户拒绝 / 超时 / 失败）和参数。被拒绝的调用同样记录在案。

### 安装 / MCP

两件事：

- **接入外部 MCP 服务器**：把本机已有的 MCP 服务器（如 filesystem server）添加进来，模型就能用它的工具，且同样受策略、审批和审计约束（见 [docs/mcp-servers.md](docs/mcp-servers.md)）；
- **OpenAI Secure MCP Tunnel**：填入 Tunnel ID 和 Runtime API Key，勾选启用，控制面板会自动把本机 MCP 服务安全地接到 ChatGPT / Codex，无需额外安装任何东西。

### 审批弹窗

模型发起需要确认的操作时，窗口中央会弹出「工具调用请求」，展示工具名、原因和完整参数。三个按钮：

- **拒绝**：这次不放行；
- **仅本次允许**：这次放行，下次还要问；
- **始终允许**：记住这次决定，以后同样的操作不再询问。

超过 180 秒不处理，调用会被自动拒绝。

---

## 模型能用的工具

模型通过 MCP 只能看到以下 5 个工具（Codex 兼容形式）：

| 工具 | 默认权限 | 说明 |
| --- | --- | --- |
| `read_file` | 需确认 | 读取文本文件，默认带行号；传 `lineNumbers: false` 可拿到**逐字节一致**的原文。二进制文件会被拒绝而不是返回乱码。 |
| `list_dir` | 允许 | 列目录，可选递归与 glob 过滤。 |
| `exec` | 需确认 | 用配置好的 Shell 执行命令，捕获输出与退出码。 |
| `unified_exec` | 需确认 | Codex unified-exec 兼容形式，与 `exec` 相同。 |
| `apply_patch` | 需确认 | 用补丁创建、修改、删除、移动文件。 |

> 关于 `lineNumbers`：带行号会改变行尾细节（CRLF、"末尾没有换行"会被改写）。模型要"读出来再写回去"时请用 `lineNumbers: false`，那种模式返回的是原文本身。

---

## 安全设计（用户视角）

- **默认拒绝**：没设置工作目录、或窗口已关闭时，需要确认的调用一律拒绝——宁可失败，不悄悄放行；
- **路径沙箱**：模型只能访问你添加的工作目录，`..`、符号链接都绕不出去；`.ssh`、`.env`、密钥文件即使在工作目录里也读不到；
- **命令黑名单**：`rm -rf`、磁盘格式化这类破坏性命令优先级最高，任何规则都放行不了；
- **私网拦截**：默认禁止模型访问本机与局域网地址（防止它借机读取云服务器元数据等内部信息），重定向会逐跳重新校验；
- **公网认证隔离**：默认本机服务只监听 `127.0.0.1`；Direct Remote MCP 与 Tunnel/本地 bridge secret 分离，可选独立 Bearer、OAuth 2.1 + PKCE，或把 256-bit Secret Path 本身作为 capability credential。

---

## 无界面模式（可选）

不需要窗口时，可以直接运行内置服务：

```bash
./src/target/release/ltb-host serve-mcp        # MCP，默认 http://127.0.0.1:8789/mcp
# Direct/反代模式：需显式提供 Bearer token 文件
./src/target/release/ltb-host serve-mcp --mcp-bind 127.0.0.1 --mcp-port 8792 --mcp-bearer-token-file /path/to/token
./src/target/release/ltb-host serve            # HTTP，默认 http://127.0.0.1:8788/rpc
./src/target/release/ltb-host serve-ws         # WebSocket
./src/target/release/ltb-host --print-secret   # 只打印连接令牌
```

注意：无界面模式没有审批窗口，需要确认的工具会被直接拒绝；想用 `exec`、`apply_patch` 请用控制面板，或在策略里设为「允许」。

配置与数据文件位置：

- Windows：`%APPDATA%\local-tool-bridge\`
- macOS：`~/Library/Application Support/local-tool-bridge/`
- Linux：`~/.config/local-tool-bridge/`

包括连接令牌（`secret`）、策略（`policy.json`）、审计日志（`audit.jsonl`）、MCP 服务器配置（`mcp.json`）、Direct MCP 配置与凭据（`direct-mcp*.json` / `direct-mcp-*`）、隧道配置（`tunnel.json`）等。

---

## 项目结构

```
local-tool-bridge/
├── docs/
│   ├── chatgpt-mcp.md           # 接入 ChatGPT / Codex 的完整指南
│   └── mcp-servers.md           # 接入外部 MCP 服务器指南
├── src/                         # Rust 工作区
│   └── crates/
│       ├── core/                # 策略引擎、路径沙箱、工具、审计
│       ├── host/                # HTTP / WebSocket / MCP 传输与内置隧道
│       └── gui/                 # egui 控制面板
└── scripts/                     # 端到端冒烟测试（驱动真实二进制）
```

---

## 测试

```bash
cd src && cargo test                          # 单元测试 + 集成测试
node scripts/smoke-http.mjs                    # HTTP 端到端（需先构建）
node scripts/smoke-mcp.mjs                     # MCP 端到端（需先构建）
```

---

## 已知限制

- **审计日志按大小轮转（8 MB）**，会丢弃最旧的一半。
- **控制面板的中文依赖系统中文字体。** 字体按候选列表从系统加载（Windows 上依次尝试微软雅黑、黑体、宋体、等线）；系统里一个候选都没有时，程序仍会启动，只是中文会退回成 `□`。

## 许可

MIT
