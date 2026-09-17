# 外部 MCP 服务器

Local Tool Bridge 现在可以把本机 stdio MCP 服务器作为自己的工具源。

## 配置文件

运行 GUI/host 后，配置文件位置为：

- Windows: `%APPDATA%\local-tool-bridge\mcp.json`
- macOS: `~/Library/Application Support/local-tool-bridge/mcp.json`
- Linux: `~/.config/local-tool-bridge/mcp.json`

仓库提供了 `mcp.example.json` 作为模板。

配置格式：

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

- `command`: MCP stdio server 的启动程序。
- `args`: 启动参数。
- `env`: 传给 MCP server 的环境变量。
- `cwd`: 可选的工作目录。
- `enabled`: 是否在 bridge 启动时加载。
- `default_effect`: 接入 bridge 后该服务器工具默认的策略，支持 `allow`、`ask`、`deny`。

## 工作方式

启动 bridge 时会：

1. 读取 `mcp.json`。
2. 启动每个 enabled server。
3. 使用 MCP `initialize` 完成握手。
4. 调用 `tools/list`。
5. 将远端工具注册到 Local Tool Bridge 的统一 ToolRegistry。
6. 模型调用这些工具时，仍然经过 Local Tool Bridge 的 policy、approval 和 audit。

代理工具名格式为 `mcp_<server>_<tool>`，这样不同 MCP server 的同名工具不会直接冲突。

修改 `mcp.json` 后需要重启 bridge 才会重新发现工具。当前版本支持本地 stdio MCP server；HTTP/SSE/Streamable HTTP 上游服务器可以在后续版本加入。

## Bridge 自身的 MCP 配置

Local Tool Bridge 本身继续提供 MCP endpoint，例如：

`http://127.0.0.1:8789/mcp`

实际端口以 GUI 的「状态」页为准。可以使用 `mcp-client.json` 作为客户端侧配置模板，其中包含当前 bridge 地址和本机 secret；该文件包含敏感凭据，不要提交到 Git。
