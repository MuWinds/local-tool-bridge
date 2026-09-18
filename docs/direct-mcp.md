# Direct Remote MCP 与 Caddy

Local Tool Bridge 默认仍通过 loopback MCP + OpenAI Secure MCP Tunnel 接入。
如果你的机器已有公网 IP / 域名，也可以启用一个**独立**的 Direct Remote MCP
listener，并让 Caddy 负责公网 HTTPS。

## 架构

```text
ChatGPT / MCP Client
        │
        │ HTTPS :443
        ▼
mcp.example.com
        │
      Caddy
        │
        │ HTTP loopback
        ▼
127.0.0.1:8792/mcp
        │
 Local Tool Bridge
```

Direct listener 与原有 Tunnel listener 分离：

- Tunnel / 本地 MCP：继续使用 `x-dlb-secret`；
- Direct Remote MCP：使用独立 `Authorization: Bearer <token>`；
- 默认 Direct 功能关闭；升级不会新增任何公网监听。

## 1. 在 GUI 中启用

「安装 / MCP」→ **Direct Remote MCP**：

1. 勾选「启动 GUI 时自动运行 Direct Remote MCP」；
2. Bind 保持 `127.0.0.1`；
3. Port 保持默认 `8792`；
4. 可填写 Public URL，例如 `https://mcp.example.com`；
5. 点「复制 Bearer Token」生成/复制独立 Token；
6. 保存配置并重启控制面板。

如果不用 GUI，也可以：

```bash
ltb-host serve-mcp \
  --mcp-bind 127.0.0.1 \
  --mcp-port 8792 \
  --mcp-bearer-token-file /path/to/direct-mcp-token
```

为了防止误配置，CLI 只要进入非默认 Direct 模式就要求显式提供 Bearer Token
文件；不能把一个匿名 MCP listener 直接绑定到公网。

## 2. DNS

为域名创建 A / AAAA 记录，例如：

```text
mcp.example.com -> 你的公网 IP
```

如果 IP 会变化，可以继续用 DDNS。

## 3. Caddy

最小 Caddyfile：

```caddyfile
mcp.example.com {
    reverse_proxy 127.0.0.1:8792
}
```

Caddy 在这里做两件事：

1. 对公网监听 80/443，并自动申请、续期 HTTPS 证书；
2. 把 HTTPS 请求反向代理到只监听 loopback 的 Local Tool Bridge。

不要让 Caddy 无条件替每个公网请求注入 `x-dlb-secret`，否则等价于把本地
bridge secret 变成由代理自动代填的公共通行证。正确做法是让客户端发送标准：

```http
Authorization: Bearer <Direct MCP token>
```

Caddy 只负责 TLS 和反向代理，不替陌生请求伪造 LTB 凭据。

## 4. 防火墙

推荐只从公网开放 Caddy：

```text
TCP 80   -> Caddy（证书/重定向）
TCP 443  -> Caddy（HTTPS）
TCP 8792 -> 不对公网开放
```

LTB 保持 `127.0.0.1:8792` 时，8792 本身无法被远程主机直接连接。

如果你确实需要直接绑定 `0.0.0.0`，必须同时提供 Bearer Token，并自行解决
TLS；一般不如 Caddy + loopback 安全、方便。

## 5. 客户端

MCP endpoint：

```text
https://mcp.example.com/mcp
```

认证：

```text
Authorization: Bearer <Direct MCP token>
```

不同 ChatGPT 计划/工作区可用的自定义 MCP 认证选项可能不同。如果当前 UI
没有静态 Bearer 选项，可继续使用 Secure MCP Tunnel，或在 Direct endpoint
前部署兼容的 OAuth 网关；两种模式不会互相影响。

## 安全边界

Direct Remote MCP 只解决**传输与认证**，不会把 shell 变成 sandbox。

- 文件工具仍经过 PathSandbox；
- exec 仍是真实 shell，并拥有运行 LTB 的 OS 用户权限；
- 本地审批、Policy、审计对 Direct 请求同样生效；
- Direct Token 与 bridge secret 分离，泄露其中一个不会自动泄露另一个；
- 推荐使用普通用户运行 LTB，不要以 Administrator/root 运行。
