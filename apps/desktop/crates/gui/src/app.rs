use crate::approver::PendingApproval;
use ltb_core::audit::{AuditEntry, AuditLog};
use ltb_core::dispatch::Dispatcher;
use ltb_core::policy::{Effect, Policy, Rule, ToolSchemaProfile};
use ltb_host::mcp_servers::{McpConfig, McpServerConfig};
use ltb_host::tunnel::{TunnelConfig, TunnelProcess};
use std::collections::BTreeMap;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tab {
    Status,
    Tools,
    Audit,
    Setup,
}
pub struct ActiveApproval {
    pub challenge: ltb_core::dispatch::ApprovalChallenge,
    pub responder: Option<tokio::sync::oneshot::Sender<ltb_core::dispatch::ApprovalDecision>>,
}
pub struct BridgeApp {
    pub runtime: tokio::runtime::Handle,
    pub dispatcher: Arc<Dispatcher>,
    pub audit: Arc<AuditLog>,
    pub tab: Tab,
    pub http_address: Option<String>,
    pub websocket_address: Option<String>,
    pub mcp_address: Option<String>,
    pub native_registered: bool,
    pub secret: String,
    pub policy: Policy,
    pub dirty: bool,
    pub audit_entries: Vec<AuditEntry>,
    pub active_approval: Option<ActiveApproval>,
    pending_approvals: Vec<PendingApproval>,
    pub toast: Option<(String, bool)>,
    pub new_root: String,
    pub new_host: String,
    pub mcp_config: McpConfig,
    pub new_mcp_name: String,
    pub new_mcp_command: String,
    pub new_mcp_args: String,
    pub new_mcp_cwd: String,
    pub tunnel_config: TunnelConfig,
    pub tunnel_process: Option<TunnelProcess>,
    pub tunnel_api_key: String,
}
impl BridgeApp {
    pub fn new(
        runtime: tokio::runtime::Handle,
        dispatcher: Arc<Dispatcher>,
        secret: String,
        http_address: Option<String>,
        websocket_address: Option<String>,
        mcp_address: Option<String>,
        tunnel_process: Option<TunnelProcess>,
    ) -> Self {
        let audit = dispatcher.audit().clone();
        let policy = runtime.block_on(dispatcher.policy_snapshot());
        dispatcher
            .registry()
            .set_schema_profile(match policy.tool_schema {
                ToolSchemaProfile::Bridge => ltb_core::tools::ToolSchemaProfile::Bridge,
                ToolSchemaProfile::Codex => ltb_core::tools::ToolSchemaProfile::Codex,
            });
        let tunnel_config = ltb_host::tunnel::load_config();
        Self {
            runtime,
            dispatcher,
            audit,
            tab: Tab::Status,
            http_address,
            websocket_address,
            mcp_address,
            native_registered: crate::install::native_host_registered(),
            secret,
            policy,
            dirty: false,
            audit_entries: Vec::new(),
            active_approval: None,
            pending_approvals: Vec::new(),
            toast: None,
            new_root: String::new(),
            new_host: String::new(),
            mcp_config: ltb_host::mcp_servers::load_config(),
            new_mcp_name: String::new(),
            new_mcp_command: String::new(),
            new_mcp_args: String::new(),
            new_mcp_cwd: String::new(),
            tunnel_config,
            tunnel_process,
            tunnel_api_key: String::new(),
        }
    }
    pub fn poll(&mut self, approvals: &mut tokio::sync::mpsc::UnboundedReceiver<PendingApproval>) {
        while let Ok(p) = approvals.try_recv() {
            self.pending_approvals.push(p);
        }
        if self.active_approval.is_none() {
            if let Some(next) = self.pending_approvals.first_mut() {
                let challenge = next.challenge.clone();
                let responder = next.responder.take();
                self.pending_approvals.remove(0);
                self.active_approval = Some(ActiveApproval {
                    challenge,
                    responder,
                });
            }
        }
        self.audit_entries = self
            .runtime
            .block_on(self.audit.recent(200))
            .into_iter()
            .rev()
            .collect();
    }
    pub fn resolve_approval(&mut self, approved: bool, remember: bool) {
        let Some(mut active) = self.active_approval.take() else {
            return;
        };
        if let Some(responder) = active.responder.take() {
            let _ = responder.send(ltb_core::dispatch::ApprovalDecision { approved, remember });
        }
        self.toast = Some((
            if approved {
                format!("已允许 {}", active.challenge.tool)
            } else {
                format!("已拒绝 {}", active.challenge.tool)
            },
            approved,
        ));
    }
    pub fn save_policy(&mut self) {
        let policy = self.policy.clone();
        match self
            .runtime
            .block_on(self.dispatcher.replace_policy(policy))
        {
            Ok(revision) => {
                self.dispatcher
                    .registry()
                    .set_schema_profile(match self.policy.tool_schema {
                        ToolSchemaProfile::Bridge => ltb_core::tools::ToolSchemaProfile::Bridge,
                        ToolSchemaProfile::Codex => ltb_core::tools::ToolSchemaProfile::Codex,
                    });
                match ltb_host::save_policy(&self.policy) {
                    Ok(path) => {
                        self.policy.revision = revision;
                        self.dirty = false;
                        self.toast = Some((format!("策略已保存到 {}", path.display()), true));
                    }
                    Err(e) => self.toast = Some((format!("保存策略文件失败：{e}"), false)),
                }
            }
            Err(e) => self.toast = Some((format!("策略无效：{e}"), false)),
        }
    }
    pub fn set_effect(&mut self, tool: &str, effect: Effect) {
        if let Some(rule) = self
            .policy
            .rules
            .iter_mut()
            .find(|r| r.tool == tool && r.when.is_none())
        {
            rule.effect = effect
        } else {
            self.policy.rules.insert(
                0,
                Rule {
                    tool: tool.to_string(),
                    effect,
                    when: None,
                    note: None,
                },
            );
        }
        self.dirty = true;
    }
    pub fn effect_for(&self, tool: &str) -> Effect {
        self.policy
            .rules
            .iter()
            .find(|r| r.tool == tool && r.when.is_none())
            .map(|r| r.effect)
            .unwrap_or(Effect::Ask)
    }
    pub fn copy_secret(&self, ctx: &eframe::egui::Context) {
        ctx.copy_text(self.secret.clone());
    }
    pub fn add_mcp_server(&mut self) {
        let name = self.new_mcp_name.trim().to_string();
        let command = self.new_mcp_command.trim().to_string();
        if name.is_empty() || command.is_empty() {
            self.toast = Some(("MCP 服务器名称和启动命令不能为空".into(), false));
            return;
        }
        let args = self
            .new_mcp_args
            .split_whitespace()
            .map(str::to_string)
            .collect();
        self.mcp_config.servers.insert(
            name,
            McpServerConfig {
                command,
                args,
                env: BTreeMap::new(),
                cwd: if self.new_mcp_cwd.trim().is_empty() {
                    None
                } else {
                    Some(self.new_mcp_cwd.trim().into())
                },
                enabled: true,
                default_effect: ltb_core::tools::DefaultEffect::Ask,
            },
        );
        self.new_mcp_name.clear();
        self.new_mcp_command.clear();
        self.new_mcp_args.clear();
        self.new_mcp_cwd.clear();
    }
    pub fn save_mcp_config(&mut self) {
        match ltb_host::mcp_servers::save_config(&self.mcp_config) {
            Ok(path) => {
                self.toast = Some((
                    format!("MCP 配置已保存到 {}。重启桥接后生效。", path.display()),
                    true,
                ))
            }
            Err(e) => self.toast = Some((format!("保存 MCP 配置失败：{e}"), false)),
        }
    }
    pub fn export_client_mcp_config(&mut self) {
        let Some(address) = self.mcp_address.as_deref() else {
            self.toast = Some(("MCP 服务尚未监听，无法生成客户端配置".into(), false));
            return;
        };
        match ltb_host::mcp_servers::save_client_config(address, &self.secret) {
            Ok(path) => {
                self.toast = Some((format!("客户端 MCP 配置已写入 {}", path.display()), true))
            }
            Err(e) => self.toast = Some((format!("写入客户端 MCP 配置失败：{e}"), false)),
        }
    }
    pub fn save_tunnel_config(&mut self) {
        match ltb_host::tunnel::save_config(&self.tunnel_config) {
            Ok(path) => {
                self.toast = Some((
                    format!("Secure MCP Tunnel 配置已保存到 {}", path.display()),
                    true,
                ))
            }
            Err(e) => self.toast = Some((format!("保存 Tunnel 配置失败：{e}"), false)),
        }
    }
    pub fn save_tunnel_api_key(&mut self) {
        if self.tunnel_api_key.trim().is_empty() {
            self.toast = Some(("Runtime API Key 不能为空".into(), false));
            return;
        }
        match ltb_host::tunnel::save_api_key(&self.tunnel_api_key) {
            Ok(path) => {
                self.tunnel_config.api_key_file = path.display().to_string();
                self.tunnel_api_key.clear();
                self.save_tunnel_config();
            }
            Err(e) => self.toast = Some((format!("保存 Tunnel API Key 失败：{e}"), false)),
        }
    }
}
