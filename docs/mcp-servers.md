# 接入外部 MCP 服务器

Local Tool Bridge 可以启动本机的 MCP 服务器（stdio 类型），把它们提供的工具交给 ChatGPT / Codex 使用——同样受策略、审批和审计约束。

## 在控制面板里添加（推荐）

1. 打开控制面板，进入「**安装 / MCP**」页；
2. 在「添加 MCP Server」区域填写：
   - **名称**：任意名字，例如 `filesystem`；
   - **Command**：启动命令，例如 `npx`；
   - **Arguments**：参数，例如 `-y @modelcontextprotocol/server-filesystem C:/work`（按空格分隔，多个参数逐个写）；
   - **工作目录**（可选）：服务器进程的工作目录；
3. 点「**添加服务器**」；
4. 点「**保存 mcp.json**」。

服务器列表里，每个条目可以：

- 勾选「**启用**」控制是否随桥接启动加载；
- 通过下拉设置**默认权限**：默认允许 / 默认需确认 / 默认禁止；
- 点「**删除**」移除。

> 修改后需要重启控制面板（或重新启动桥接）才会生效。

## 生成客户端 MCP 配置（可选）

如果其他 MCP 客户端想直接连到本机桥接，点「**写入客户端 MCP 配置**」，会在配置目录生成 `mcp-client.json`，里面包含桥接地址和共享令牌。该文件含敏感凭据，请勿提交到 Git。

## 配置文件（高级）

控制面板的修改会写入同一个配置文件，也可以直接编辑它：

- Windows：`%APPDATA%\local-tool-bridge\mcp.json`
- macOS：`~/Library/Application Support/local-tool-bridge/mcp.json`
- Linux：`~/.config/local-tool-bridge/mcp.json`

仓库里的 `mcp.example.json` 是模板。格式：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/work"],
      "env": {},
      "enabled": true,
      "default_effect": "ask"
    }
  }
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `command` | MCP 服务器的启动程序 |
| `args` | 启动参数 |
| `env` | 传给 MCP 服务器的环境变量 |
| `cwd` | 可选的工作目录 |
| `enabled` | 是否随桥接启动加载 |
| `default_effect` | 接入桥接后工具默认的策略：`allow` / `ask` / `deny` |

## 工作方式

桥接启动时会读取 `mcp.json`，启动每个已启用的服务器，完成 MCP 握手、获取工具列表，然后把工具注册进统一的工具注册表。模型调用这些工具时，仍然经过 Local Tool Bridge 的策略、审批和审计。

代理工具名格式为 `mcp_<服务器名>_<工具名>`，不同服务器的同名工具不会冲突。

当前版本支持本地 stdio MCP 服务器；远程 HTTP / SSE / Streamable HTTP 类型的 MCP 服务器暂不支持。

## 本桥接自身的 MCP 端点

Local Tool Bridge 本身也对外提供 MCP 端点（供 ChatGPT / Codex 等客户端连接），地址见控制面板「状态」页（通常 `http://127.0.0.1:8790/mcp`）。接入 ChatGPT 的完整方法见 [chatgpt-mcp.md](chatgpt-mcp.md)。
