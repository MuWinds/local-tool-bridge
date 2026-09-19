# 让 ChatGPT 使用本机的 Local Tool Bridge 工具

本指南带你把 ChatGPT / Codex 接到本机工具。全程只做三件事：在 OpenAI 平台准备一条 Tunnel、在控制面板里填进去、在 ChatGPT 里创建一个 Connector。

完成后，ChatGPT 可以读取你指定文件夹里的文件、执行命令、修改代码——每一步需要确认的操作都会先在控制面板弹窗问你，并且全部留下审计记录。

## 总览

```
ChatGPT
   │  经 OpenAI 隧道（HTTPS 安全通道）
   ▼
本机控制面板（ltb-gui）
   │  内置隧道 ←→ 本机 MCP 服务
   ▼
你电脑上的工具（读文件 / 列目录 / 执行命令 / 修改文件）
   │
   └── 每次需要确认的调用，都会弹窗问你
```

整个过程不需要开放端口，也不需要额外安装任何客户端程序。

## 第 1 步：在 OpenAI 平台准备（一次性）

1. 打开 [Tunnels 设置页](https://platform.openai.com/settings/organization/tunnels)，创建一条 Tunnel，记下以 `tunnel_` 开头的 **Tunnel ID**。
2. 打开 [API Keys 设置页](https://platform.openai.com/settings/organization/api-keys)，创建一条 **Runtime API key**（权限需包含 Tunnels Read + Use），记下以 `sk-` 开头的值。

> 需要能登录 platform.openai.com 且具备 Tunnels 权限的账号（组织管理员可以创建）。

## 第 2 步：在控制面板里启用隧道

1. 启动控制面板：`./src/target/release/ltb-gui`；
2. 打开「**安装 / MCP**」页，找到 **OpenAI Secure MCP Tunnel** 区域；
3. 在 **Tunnel ID** 一栏粘贴第 1 步记下的 Tunnel ID；
4. 在 **Runtime API Key** 输入框粘贴第 1 步记下的 API Key，点「**保存 Tunnel API Key**」（密钥只写入本机文件，界面不显示已有值）；
5. 勾选「**启动 GUI 时自动运行 Rust Tunnel**」，点「**保存 Tunnel 配置**」。

回到「**状态**」页，**Secure MCP Tunnel** 一栏应显示「已运行」。如果显示「已启用但未运行」，检查 Tunnel ID / API Key 是否正确，或在「安装 / MCP」页调大「启动等待」（默认 60 秒）后重启控制面板。

> 勾选启用后，每次启动控制面板都会自动运行隧道，无需重复配置。
> 本机 MCP 地址（通常 `http://127.0.0.1:8790/mcp`）由控制面板自动管理，以「状态」页显示为准，无需手填。

## 第 3 步：在 ChatGPT 里创建 Connector

1. 打开 [Connectors 设置](https://chatgpt.com/#settings/Connectors)（需 ChatGPT 账号）；
2. 新建 Connector，**Connection 选 Tunnel**，从下拉选择你的 Tunnel（没出现就点 "Enter tunnel ID instead" 手填）；
3. **Authentication 选 No Authentication**——走 Tunnel 时身份验证由 OpenAI 账号完成，选 OAuth 会让「扫描工具」去请求不存在的 OAuth 端点而失败；
4. 点 **Scan Tools** 扫描工具，确认控制面板在运行且隧道显示「已运行」，成功后应看到 5 个工具（`read_file`、`list_dir`、`exec`、`unified_exec`、`apply_patch`）；
5. 点 **Create** 保存。

## 使用

在 ChatGPT 会话里发起一个会用到本机工具的任务，例如：

> 读取 C:\Users\me\project\README.md 并总结。

涉及「需确认」工具的调用，控制面板会弹出审批框，你可以选择「拒绝 / 仅本次允许 / 始终允许」。

## 安全说明

- 本机 MCP 服务只监听 `127.0.0.1`，不暴露到局域网；
- 每个请求（包括握手）都校验本机共享令牌，控制面板在连接时自动携带，你无需手动配置；
- 策略、路径沙箱、命令黑名单对来自 ChatGPT 的调用**完全生效**；
- 没有控制面板（或窗口已关闭）时，需要确认的调用会被一律拒绝，不会悄悄放行。

## 故障排查

| 现象 | 检查 |
| --- | --- |
| 「状态」页 Tunnel 显示「已启用但未运行」 | Tunnel ID 是否完整；API Key 是否已保存；「启动等待」是否太短 |
| ChatGPT 扫描不到工具 / Connector 连不上 | 控制面板是否在运行、Tunnel 是否显示「已运行」；tunnel 权限是否 Read + Use |
| 调用被拒绝 | 这是策略 / 审批在拦截：在控制面板批准，或把该工具 / 目录设为「允许」 |
| 工具名找不到 | 工具名是 Codex 兼容形式（`read_file` 等），可在「工具与策略」页核对 |
| ChatGPT 报 `server/discover response was invalid` | 本地版本过旧：重新 `cargo build -p ltb-gui` 并重启控制面板 |

## 附录：无界面模式（高级）

大多数用户不需要本附录。无界面模式（`ltb-host serve-mcp`）没有审批窗口，需要确认的调用会被直接拒绝；且隧道需要自行用外部 `tunnel-client` 运行，并把本机共享令牌配置进它的环境变量。要点：

1. 启动 MCP 端点：`./src/target/release/ltb-host serve-mcp --mcp-port 8789`，记下打印的地址与令牌（令牌文件：Windows `%APPDATA%\local-tool-bridge\secret`、macOS `~/Library/Application Support/local-tool-bridge/secret`、Linux `~/.config/local-tool-bridge/secret`）；
2. 配置 `tunnel-client`（[openai/tunnel-client](https://github.com/openai/tunnel-client/releases)）：`MCP_SERVER_URL` 指向上述地址，`MCP_EXTRA_HEADERS` 与 `MCP_DISCOVERY_EXTRA_HEADERS` 都携带 `x-dlb-secret`（推荐用 `file:` 引用令牌文件，避免明文进 shell 历史；`MCP_DISCOVERY_EXTRA_HEADERS` 不能省，否则启动探测会 401）；
3. 用 `tunnel-client doctor --explain` 验证，`tunnel-client run` 常驻运行；之后在 ChatGPT 创建 Connector，步骤同第 3 步。

配置样例见 `docs/tunnel-client.chatgpt.yaml`。
