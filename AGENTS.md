# AGENTS.md

## Commands

仓库根目录是 JavaScript 包管理元数据所在的位置，但实际应用代码是 `src/` 下的 Rust workspace。除 `package.json` 中提供的脚本外，Rust 命令通常在 `src/` 目录执行。

```bash
# 在仓库根目录
npm test

# Rust：构建、检查与格式化
cd src && cargo build --release
cd src && cargo check --workspace --all-targets
cd src && cargo fmt --all -- --check
cd src && cargo clippy --workspace --all-targets --all-features -- -D warnings

# Rust 测试
cd src && cargo test --workspace --all-features

# 端到端冒烟测试（先完成构建）
node scripts/smoke-http.mjs
node scripts/smoke-mcp.mjs
```

发布构建以 `ltb-gui` 为主要产物；无界面服务对应 `ltb-host`。跨平台 CI 当前覆盖 Windows、Ubuntu 和 macOS。

## Testing

- 单元/集成测试统一使用 Cargo：`cd src && cargo test --workspace --all-features`。
- `ltb-core` 目前包含 `tests/dispatch.rs` 集成测试，重点覆盖调度、策略与工具调用链。
- HTTP/MCP 的真实二进制冒烟测试位于 `scripts/`，适合验证传输层与端到端行为；运行前先构建所需二进制。
- 修改策略、路径沙箱、Shell、HTTP 或 MCP 行为时，优先同时补对应测试与回归场景，不要只依赖手工启动 GUI 验证。
- CI 的门槛是 `cargo fmt --all -- --check`、Clippy 严格到 `-D warnings`、MSRV 检查，以及三平台全工作区测试和 GUI release build。

## Project Structure

```text
local-tool-bridge/
├── README.md                    # 用户视角的使用、能力与安全说明
├── docs/                        # ChatGPT/MCP 接入、Direct Remote MCP 与 Tunnel 文档
├── scripts/                     # HTTP/MCP 端到端冒烟脚本
├── .github/workflows/           # CI 与 release pipeline
└── src/                         # Rust workspace
    ├── Cargo.toml
    ├── rustfmt.toml
    └── crates/
        ├── core/                # 策略、路径沙箱、工具、调度、审计；保持传输无关
        ├── host/                # HTTP/WebSocket/MCP 传输、Direct Remote MCP/OAuth、Secure MCP Tunnel
        └── gui/                 # egui 控制面板、审批交互与桌面集成
```

依赖方向应保持清晰：`core` 不应引入窗口或平台 GUI 逻辑；传输层把请求交给统一的 `Dispatcher`，由 core 负责校验、策略、审批、执行和审计。

## Code Style

项目使用 Rust 2021 edition，并通过 `src/rustfmt.toml` 固定 Rust Style Guide 的 `style_edition = "2024"`。crate 的最低支持 Rust 版本是 1.88；`cargo fmt` 因 style edition 要求当前 CI 使用 Rust 1.94+。

优先遵循 `rustfmt` 自动格式化、Clippy 无 warning 的写法。保持现有的模块化与错误传播模式，使用仓库里的 `crate::error::{BridgeError, Result}` 统一返回错误，参数解析优先复用 `required_str`、`optional_str`、`optional_u64` 等现有 helper。

示例：

```rust
pub fn require(&self, name: &str) -> Result<&Arc<dyn Tool>> {
    self.get(name)
        .ok_or_else(|| BridgeError::tool_not_found(name))
}
```

异步工具实现遵循现有 `Tool` trait / `async_trait` 模式；结构体、枚举和序列化字段继续使用 `serde` 现有命名约定（例如对外 JSON 的 camelCase）。避免为了局部代码风格引入新的抽象、日志框架或依赖。

## Git Workflow

- 先检查 `git status`，不要覆盖或清理与当前任务无关的工作区修改。
- 保持提交粒度小而单一：一个提交解决一个逻辑问题，尤其不要把格式化大改与功能修改混在一起。
- 提交消息沿用仓库现有风格：简短、以动词开头、描述实际变更；标题与正文使用中文，例如 `修复 CI 格式化与 clippy 告警`。
- 提交前至少运行与改动相关的格式化、Clippy 和测试；涉及跨平台代码时优先跑完整 workspace 检查。
- 不要提交 `src/target/`、本地配置、运行时审计日志、连接令牌或其他生成物；以仓库现有 `.gitignore` 和 CI 产物规则为准。
- Release 通过 `v*` tag 触发 GitHub Actions，不要手工把 release archive 放进源码树。

## Git 提交约定

- 本项目的 Git commit 标题和正文使用中文。
- 如采用 Conventional Commits，可保留 `feat:`、`fix:`、`docs:`、`refactor:` 等类型前缀，但后面的提交描述必须使用中文。
- 标准 Git trailer（例如 `Co-authored-by:`）保持规范格式，不要求翻译。

## Boundaries

- 不要削弱或绕过安全策略来让开发测试更方便。尤其是破坏性 Shell denylist、路径沙箱、审批机制和审计必须保持在策略/调度链路中。
- 新增文件或修改文件访问逻辑时，必须继续经过 `PolicyEngine` / `PathSandbox`；不能通过绝对路径、`..`、符号链接或其他路径拼接方式绕出已授权 roots。
- 不要把任意 Shell 权限默认改成允许；默认行为应继续遵循现有 policy，破坏性命令即使配置为 allow 也必须被拒绝。
- `core` 必须保持 transport-agnostic 且不依赖 GUI/platform-specific windowing code。
- 对外 MCP 暴露的工具集合是稳定的 Codex-compatible 五工具集合：`read_file`、`list_dir`、`exec`、`unified_exec`、`apply_patch`。不要因为内部新增工具就自动扩大外部暴露面。
- 不要把连接令牌、Runtime API Key、策略文件或审计数据写入源码、测试 fixture 或日志输出；敏感配置使用应用的用户配置目录。
- 不要编辑 `target/` 下的构建产物来“修复”问题；修改源代码、Cargo 配置或 CI 定义后重新生成。
- 修改 API、协议、工具 schema 或安全边界时，同步检查 `README.md`、`docs/`、冒烟脚本与测试，避免文档和实际行为分叉。
