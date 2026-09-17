# 让 ChatGPT 使用本机的 Local Tool Bridge 工具

通过 **OpenAI Secure MCP Tunnel**（`openai/tunnel-client`）把 ChatGPT / Codex

连接到本地运行的 bridge MCP 端点。ChatGPT 侧发出 MCP 调用 → OpenAI 隧道服务 →

你本机的 `tunnel-client` 守护进程 → `ltb-host` 的 `/mcp` 端点 → 与 DeepSeek

网页扩展**完全同一套**工具、策略、审批与审计。



```
ChatGPT（Connector）

&#x20;  │  MCP JSON-RPC（经 OpenAI 托管隧道）

&#x20;  ▼

OpenAI Secure MCP Tunnel 控制面  ── 长轮询 ──►  tunnel-client（本机守护进程）

&#x20;                                                │  MCP Streamable HTTP + x-dlb-secret

&#x20;                                                ▼

&#x20;                                       ltb-host / ltb-gui（http://127.0.0.1:8789/mcp）

&#x20;                                                │  同一个 Dispatcher

&#x20;                                                ▼

&#x20;                                       fs.\* / shell.exec / http.request

&#x20;                                       （策略 → 审批 → 执行 → 审计）
```

## 1. 前置条件



* 一个能登录 [platform.openai.com](https://platform.openai.com) 的账号，并具备

  Tunnels 权限（组织管理员可创建 tunnel 与 Runtime API key）。

* 本仓库已构建好的本地宿主。**推荐用控制面板&#x20;**`ltb-gui`（审批弹窗可用），

  或纯命令行 `ltb-host serve-mcp`。

* `tunnel-client` 二进制：macOS 用 `brew install openai/tools/tunnel-client`；

  其他平台从 [openai/tunnel-client Releases](https://github.com/openai/tunnel-client/releases)

  下载，或用 `go build -o bin/tunnel-client ./cmd/client` 自行构建。

## 2. 启动本地 MCP 端点

**方式 A（推荐）：控制面板**



```
./apps/desktop/target/release/ltb-gui
```

「状态」页会出现 `MCP（ChatGPT）` 一栏，地址形如 `http://127.0.0.1:8790/mcp`

（控制面板按 `8788 → 8789 → 8790 → 8791` 顺序分配端口，HTTP 占 8788、WebSocket

占 8789，MCP 通常落在 8790）。**把这一行地址记下来**，后面 `MCP_SERVER_URL` 要用。

**方式 B：无界面宿主**



```
./apps/desktop/target/release/ltb-host serve-mcp --mcp-port 8789
```

启动时会打印 `ltb-host MCP listening on http://127.0.0.1:8789/mcp` 和

`bridge secret: <hex>`。注意：无界面宿主没有审批窗口，所有「需确认」的调用会

被直接拒绝（fail-closed）—— 想用 `fs.write_file`、`shell.exec` 这类工具，请用

方式 A，或在控制面板里把它们配置成「允许」。

## 3. 准备 OpenAI 侧（一次性）



1. 打开 [https://platform.openai.com/settings/organization/tunnels](https://platform.openai.com/settings/organization/tunnels)，创建或

   沿用一条 tunnel，记下 `tunnel_` 开头的 **Tunnel ID**。

2. 打开 [https://platform.openai.com/settings/organization/api-keys](https://platform.openai.com/settings/organization/api-keys)，创建一条

   **Runtime API key**（角色需具备 Tunnels Read + Use）。这是

   `CONTROL_PLANE_API_KEY`。

3. 本机 bridge 的共享令牌就是 `ltb-host` 启动时打印的 `bridge secret`，它持久化在：

   后面把它配置进 `MCP_EXTRA_HEADERS`（及 `MCP_DISCOVERY_EXTRA_HEADERS`）。

* Windows：`%APPDATA%\local-tool-bridge\config\secret`

* macOS：`~/Library/Application Support/local-tool-bridge/secret`

* Linux：`~/.config/local-tool-bridge/secret`

## 4. 配置并运行 tunnel-client

`tunnel-client` 只需要三样东西：tunnel ID、runtime key、本地 MCP URL。

**secret 通过自定义头携带**，因为 bridge 对 `/mcp` 的每个请求（包括

`initialize`）都校验 `x-dlb-secret`。

### 4.1 环境变量方式（最小路径）



```
export CONTROL\_PLANE\_API\_KEY="sk-..."                 # Runtime API key

export CONTROL\_PLANE\_TUNNEL\_ID="tunnel\_0123456789abcdef0123456789abcdef"

\# 把第 2 步记下的地址填进来；secret 用 file: 引用，避免进 shell 历史

export MCP\_SERVER\_URL="http://127.0.0.1:8790/mcp"

export MCP\_EXTRA\_HEADERS="x-dlb-secret: file:C:/Users/<你>/AppData/Roaming/local-tool-bridge/config/secret"

export MCP\_DISCOVERY\_EXTRA\_HEADERS="x-dlb-secret: file:C:/Users/<你>/AppData/Roaming/local-tool-bridge/config/secret"

tunnel-client run --log.level=info --log.format=struct-text
```

> `MCP_DISCOVERY_EXTRA_HEADERS`
>
>  与 
>
> `MCP_EXTRA_HEADERS`
>
>  都要设：tunnel-client
> 启动时对 MCP 端点做一次 
>
> `initialize`
>
>  探测，那次探测走的是 discovery headers；
> 只设 
>
> `MCP_EXTRA_HEADERS`
>
>  会让探测 401、
>
> `/readyz`
>
>  一直 not ready。
> 想先验证配置再常驻运行，用 
>
> `tunnel-client doctor --profile ... --explain`
>
> 。
> 如果 
>
> `file:`
>
>  引用在你的 tunnel-client 版本上解析有问题（个别 Windows 版本对
> 路径前缀处理不一致），改用环境变量形式：
> `export DLB_SECRET=$(cat "$APPDATA/local-tool-bridge/config/secret")`
>
> ，
> 然后把两处头写成 
>
> `x-dlb-secret: env:DLB_SECRET`
>
> 。

### 4.2 Profile 方式（推荐，便于管理与排查）

仓库里附了一份可直接改的样例：`docs/tunnel-client.chatgpt.yaml`。



```
tunnel-client init --profile chatgpt --tunnel-id tunnel\_0123456789abcdef0123456789abcdef --mcp-server-url http://127.0.0.1:8790/mcp

\# 然后把 mcp.extra\_headers / discovery\_extra\_headers 补进生成的 profile（见样例文件）

tunnel-client doctor --profile chatgpt --explain

tunnel-client run --profile chatgpt
```

样例 `docs/tunnel-client.chatgpt.yaml`：



```
config\_version: 1

control\_plane:

&#x20; tunnel\_id: tunnel\_0123456789abcdef0123456789abcdef

&#x20; api\_key: env:CONTROL\_PLANE\_API\_KEY

log:

&#x20; level: info

health:

&#x20; listen\_addr: 127.0.0.1:8080

mcp:

&#x20; server\_urls:

&#x20;   - channel: main

&#x20;     # 以控制面板「状态」页实际显示的地址为准

&#x20;     url: http://127.0.0.1:8790/mcp

&#x20; extra\_headers:

&#x20;   # 本机 bridge 共享令牌；file: 指向 secret 文件，避免明文进配置

&#x20;   x-dlb-secret: file:C:/Users/<你>/AppData/Roaming/local-tool-bridge/config/secret

&#x20; discovery\_extra\_headers:

&#x20;   x-dlb-secret: file:C:/Users/<你>/AppData/Roaming/local-tool-bridge/config/secret

&#x20; startup\_wait\_timeout: 60s
```

### 4.3 验证守护进程健康



```
curl -fsS http://127.0.0.1:8080/healthz   # 存活

curl -fsS http://127.0.0.1:8080/readyz    # 就绪（含对 MCP 端点的探测）

curl -fsS "http://127.0.0.1:8080/health?details=true"
```

`readyz` 里 MCP 组件应为 ready；若显示未就绪，先检查第 2 步的

`ltb-gui`/`ltb-host serve-mcp` 是否仍在运行、地址与 secret 是否一致。

## 5. 在 ChatGPT 里创建 Connector



1. 打开 [https://chatgpt.com/#settings/Connectors](https://chatgpt.com/#settings/Connectors)（需 ChatGPT 账号）。

2. 新建 Connector，**Connection 选 Tunnel**，从下拉选你的 tunnel（没出现就点 "Enter tunnel ID instead" 手填），填入第 3 步的 tunnel ID。

3. **Authentication（身份验证）选 No Authentication**。走 Tunnel 时认证由 OpenAI 账号与隧道本身完成；本机 bridge 的 `x-dlb-secret` 由 tunnel-client 本地注入，ChatGPT 不需要也不应配任何身份验证——选 OAuth 会让「扫描工具」去请求一个不存在的 OAuth 端点而失败。

4. 点 **Scan Tools / 扫描工具**，确认 `tunnel-client run` 正在运行且 `/readyz` 通过，扫描成功后应看到 6 个工具（`fs_read_file`、`fs_list_dir`、`fs_search`、`fs_write_file`、`shell_exec`、`http_request`）。

5. 点 **Create** 保存。

6. 回到 ChatGPT 会话，发起一个会用到本机工具的任务，例如：

> 读取 C:\Users\me\project\README.md 并总结。

涉及「需确认」工具的调用，会像 DeepSeek 一样弹审批框。

## 6. 安全说明



* MCP 端点只绑定 `127.0.0.1`，不暴露到局域网。

* `x-dlb-secret` 与 DeepSeek 扩展用的是同一个共享令牌；任何进程拿到它都能

  驱动本机工具，请像对待密码一样保管（样例用 `file:` 引用避免明文落盘）。

* 策略、路径沙箱、命令拒绝名单、私网拦截对 MCP 调用**完全生效**—— 没有第二套

  放宽的执行路径。

* 隧道服务本身不知道你的本地 secret：`x-dlb-secret` 由本机 tunnel-client 在

  转发时附加，只发给本机 MCP 端点。

* 无审批窗口的 `ltb-host serve-mcp` 会 fail-closed，需要审批的工具一律拒绝。

## 7. 故障排查



| 现象                               | 检查                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `tunnel-client doctor` 报 MCP 401 | `MCP_DISCOVERY_EXTRA_HEADERS` / `MCP_EXTRA_HEADERS` 里的 `x-dlb-secret` 与 `ltb-host` 打印的 secret 是否一致；secret 文件路径是否正确 |
| `readyz` 显示 MCP not ready        | `ltb-gui` / `ltb-host serve-mcp` 是否在运行；`MCP_SERVER_URL` 端口是否与「状态」页一致                                               |
| Connector 建了但 ChatGPT 说连不上       | 确认 `tunnel-client run` 在运行且 `readyz` 通过；tunnel 权限是否 Read + Use                                                     |
| ChatGPT 报 `MCP server/discover response was invalid` | 本地 MCP 版本过旧：新协议（2026-07-28）要求 `server/discover` 返回规范的 `resultType: "complete"`、`supportedVersions`、`capabilities` 与 `_meta.serverInfo`，且所有 JSON-RPC 响应必须回显请求 `id`。重新 `cargo build -p ltb-gui` 并重启 ltb-gui 与 tunnel-client（当前版本已修复） |
| 调用被拒绝（`isError` 内容为拒绝原因）         | 这是 bridge 策略 / 审批在拦截：在控制面板批准、或为该工具 / 目录配置允许规则                                                                      |
| 工具名找不到                           | MCP 名是下划线形式（`fs_read_file`）；旧 dotted 名（`fs.read_file`）也能调用                                                         |
| 端口冲突                             | 手动 `serve-mcp` 默认 8789，若已开 `ltb-gui` 请改用 `--mcp-port` 换端口                                                          |

## 8. 与 DeepSeek 网页扩展的关系

两者共用同一个 `ltb-host` 与 `Dispatcher`：工具注册表、策略引擎、审批器、

审计日志完全一致，只是入口不同（扩展走 HTTP/WebSocket/Native Messaging，

ChatGPT 走 MCP）。可以同时开着 DeepSeek 扩展与 tunnel-client，互不干扰。