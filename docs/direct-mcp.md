# Direct Remote MCP、OAuth 与 Caddy

Local Tool Bridge 默认仍通过 loopback MCP + OpenAI Secure MCP Tunnel 接入。
Direct Remote MCP 是显式 opt-in 的第二条路径，推荐继续让 LTB 只监听
127.0.0.1:8792，再由 Caddy 提供公网 HTTPS。

## 架构

~~~text
ChatGPT / MCP Client
        │
        │ HTTPS
        ▼
ddns.example.com:8443
        │
      Caddy
        │
        │ HTTP loopback
        ▼
127.0.0.1:8792
        │
 Local Tool Bridge
~~~

Direct listener 支持三种认证模式，Secure MCP Tunnel 与原本的
x-dlb-secret 行为不受影响。

## 1. Static Bearer

原始 Direct MCP 行为。MCP URL 固定为：

~~~text
https://ddns.example.com:8443/mcp
~~~

客户端发送 Authorization: Bearer <direct-mcp-token>。

适合 curl、脚本和支持静态 Token 的 MCP 客户端。

## 2. OAuth 2.1 + PKCE

面向 ChatGPT 自定义 MCP App。LTB 内置一个单用户 OAuth 服务，支持：

- Authorization Code；
- PKCE S256；
- client_secret_post 与 client_secret_basic；
- 1 小时 access token；
- offline_access 对应的 30 天 refresh token；
- /.well-known/oauth-authorization-server；
- /.well-known/oauth-protected-resource；
- MCP 401 响应中的 WWW-Authenticate resource_metadata。

在 GUI 中选择 OAuth 2.1 + PKCE，填写：

~~~text
Public URL
https://ddns.example.com:8443

ChatGPT 回调 URL
<ChatGPT 创建 App 页面显示的回调 URL>
~~~

保存并重启后，可直接从 GUI 复制 Client ID、Client Secret 或完整配置。

ChatGPT 的「用户自定义 OAuth 客户端」建议填写：

~~~text
Server URL
https://ddns.example.com:8443/mcp

Auth URL
https://ddns.example.com:8443/oauth/authorize

Token URL
https://ddns.example.com:8443/oauth/token

Authorization Server
https://ddns.example.com:8443

Client ID
<LTB GUI 复制>

Client Secret
<LTB GUI 复制>

Token endpoint auth
client_secret_post

Default scopes
mcp
offline_access
~~~

Registration URL 留空。授权时浏览器会显示 Local Tool Bridge 的确认页，
点击「允许」后才会签发一次性 Authorization Code。

## 3. Secret Path / No Auth

该模式生成一个 256-bit 随机路径：

~~~text
https://ddns.example.com:8443/<high-entropy-random-token>/mcp
~~~

MCP 请求本身不需要 Authorization header，因此在 ChatGPT 中选择
No Authentication 即可。

这是一种 capability URL：拥有完整 URL 就拥有访问权限。它比公开 /mcp
且完全无认证安全得多，因为在线猜中 256-bit token 基本不可行，但它仍弱于
OAuth/Bearer：

- URL 可能进入代理访问日志；
- URL 可能出现在截图、浏览器历史、聊天记录或配置备份；
- URL 泄漏后没有第二层认证；
- 轮换 Secret Path 后必须同步更新 ChatGPT 的 Server URL。

LTB 不会在 404 错误或自身监听日志中打印该 Secret Path。若在 Caddy 中启用
access log，请把完整请求 URI 当作敏感信息处理。

GUI 中可点击「重新生成 Secret Path」立即轮换凭据；重启 LTB 后新路径生效。

## Caddy：使用已有证书与高位端口

如果家宽不能使用 80/443，但已有 *.example.com 证书，可以直接使用高位
HTTPS 端口。例如 Windows 上：

~~~caddyfile
{
    auto_https off
}

https://ddns.example.com:8443 {
    tls D:/apps/caddy/fullchain.pem D:/apps/caddy/privkey.pem
    reverse_proxy 127.0.0.1:8792
}
~~~

只需要公网转发：

~~~text
TCP 8443 -> Caddy
TCP 8792 -> 不对公网开放
~~~

Caddy 只负责 TLS 和反向代理。不要让 Caddy 无条件给公网请求注入
x-dlb-secret 或 Direct Bearer Token。

## GUI 配置

「MCP 设置」→ Direct Remote MCP：

1. 勾选「启动 GUI 时自动运行 Direct Remote MCP」；
2. Bind 保持 127.0.0.1；
3. Port 保持 8792；
4. Public URL 填实际公网 HTTPS 地址，例如 https://ddns.example.com:8443；
5. 选择认证模式；
6. 按模式配置 OAuth 回调或复制 Secret URL / Bearer Token；
7. 保存并重启控制面板。

## 测试

健康检查：

~~~powershell
curl.exe -i https://ddns.example.com:8443/health
~~~

Static Bearer：

~~~powershell
curl.exe -i -X POST https://ddns.example.com:8443/mcp -H "Content-Type: application/json" -H "Authorization: Bearer $token" --data '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{}}'
~~~

Secret Path：

~~~powershell
curl.exe -i -X POST "https://ddns.example.com:8443/<secret>/mcp" -H "Content-Type: application/json" --data '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{}}'
~~~

OAuth metadata：

~~~powershell
curl.exe -i https://ddns.example.com:8443/.well-known/oauth-authorization-server
curl.exe -i https://ddns.example.com:8443/.well-known/oauth-protected-resource
~~~

## 安全边界

Direct Remote MCP 只解决传输和认证，不会把真实 shell 变成 sandbox。

- 文件工具仍经过 PathSandbox；
- exec 仍拥有运行 LTB 的 OS 用户权限；
- 本地 Tool Policy、人工审批和审计对三种 Direct 模式都继续生效；
- 推荐使用普通用户运行 LTB，不要使用 Administrator/root；
- OAuth Client Secret、Bearer Token、Secret Path 都应按密码处理。
