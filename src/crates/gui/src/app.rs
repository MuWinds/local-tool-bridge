use crate::approver::PendingApproval;
use ltb_core::audit::{AuditEntry, AuditLog};
use ltb_core::dispatch::Dispatcher;
use ltb_core::policy::{Effect, Policy, Rule};
use ltb_host::direct_mcp::DirectMcpConfig;
use ltb_host::tunnel::{TunnelConfig, TunnelProcess};
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

pub struct BridgeAppInit {
    pub runtime: tokio::runtime::Handle,
    pub dispatcher: Arc<Dispatcher>,
    pub secret: String,
    pub http_address: Option<String>,
    pub websocket_address: Option<String>,
    pub mcp_address: Option<String>,
    pub direct_mcp_address: Option<String>,
    pub direct_mcp_config: DirectMcpConfig,
    pub tunnel_process: Option<TunnelProcess>,
}
pub struct BridgeApp {
    pub runtime: tokio::runtime::Handle,
    pub dispatcher: Arc<Dispatcher>,
    pub audit: Arc<AuditLog>,
    pub tab: Tab,
    pub http_address: Option<String>,
    pub websocket_address: Option<String>,
    pub mcp_address: Option<String>,
    pub direct_mcp_address: Option<String>,
    pub direct_mcp_config: DirectMcpConfig,
    pub secret: String,
    pub policy: Policy,
    pub dirty: bool,
    pub audit_entries: Vec<AuditEntry>,
    pub active_approval: Option<ActiveApproval>,
    pending_approvals: Vec<PendingApproval>,
    pub toast: Option<(String, bool)>,
    pub new_root: String,
    pub tunnel_config: TunnelConfig,
    pub tunnel_process: Option<TunnelProcess>,
    pub tunnel_api_key: String,
}
impl BridgeApp {
    pub fn new(init: BridgeAppInit) -> Self {
        let audit = init.dispatcher.audit().clone();
        let policy = init.runtime.block_on(init.dispatcher.policy_snapshot());
        let tunnel_config = ltb_host::tunnel::load_config();
        Self {
            runtime: init.runtime,
            dispatcher: init.dispatcher,
            audit,
            tab: Tab::Status,
            http_address: init.http_address,
            websocket_address: init.websocket_address,
            mcp_address: init.mcp_address,
            direct_mcp_address: init.direct_mcp_address,
            direct_mcp_config: init.direct_mcp_config,
            secret: init.secret,
            policy,
            dirty: false,
            audit_entries: Vec::new(),
            active_approval: None,
            pending_approvals: Vec::new(),
            toast: None,
            new_root: String::new(),
            tunnel_config,
            tunnel_process: init.tunnel_process,
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
            Ok(revision) => match ltb_host::save_policy(&self.policy) {
                Ok(path) => {
                    self.policy.revision = revision;
                    self.dirty = false;
                    self.toast = Some((format!("策略已保存到 {}", path.display()), true));
                }
                Err(e) => self.toast = Some((format!("保存策略文件失败：{e}"), false)),
            },
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
    pub fn save_direct_mcp_config(&mut self) {
        match ltb_host::direct_mcp::save_config(&self.direct_mcp_config) {
            Ok(path) => {
                self.toast = Some((
                    format!(
                        "Direct MCP 配置已保存到 {}。监听地址/认证变更将在重启后生效。",
                        path.display()
                    ),
                    true,
                ))
            }
            Err(e) => self.toast = Some((format!("保存 Direct MCP 配置失败：{e}"), false)),
        }
    }

    pub fn copy_direct_mcp_token(&mut self, ctx: &eframe::egui::Context) {
        match ltb_host::direct_mcp::load_or_create_token(&self.direct_mcp_config) {
            Ok(token) => {
                ctx.copy_text(token);
                self.toast = Some(("Direct MCP Bearer Token 已复制".into(), true));
            }
            Err(e) => self.toast = Some((format!("读取 Direct MCP Token 失败：{e}"), false)),
        }
    }

    pub fn copy_direct_mcp_endpoint(&mut self, ctx: &eframe::egui::Context) {
        match ltb_host::direct_mcp::public_mcp_url(&self.direct_mcp_config) {
            Ok(url) => {
                ctx.copy_text(url);
                self.toast = Some(("Direct MCP 公网 URL 已复制".into(), true));
            }
            Err(e) => self.toast = Some((format!("生成 Direct MCP URL 失败：{e}"), false)),
        }
    }

    pub fn rotate_direct_mcp_path(&mut self, ctx: &eframe::egui::Context) {
        match ltb_host::direct_mcp::rotate_path_token() {
            Ok(_) => match ltb_host::direct_mcp::public_mcp_url(&self.direct_mcp_config) {
                Ok(url) => {
                    ctx.copy_text(url);
                    self.toast = Some((
                        "已重新生成 Secret Path；新 URL 已复制，重启后生效".into(),
                        true,
                    ));
                }
                Err(e) => self.toast = Some((format!("生成新 Secret Path URL 失败：{e}"), false)),
            },
            Err(e) => self.toast = Some((format!("重新生成 Secret Path 失败：{e}"), false)),
        }
    }

    pub fn copy_oauth_client_id(&mut self, ctx: &eframe::egui::Context) {
        match ltb_host::direct_mcp::load_or_create_oauth_credentials() {
            Ok(credentials) => {
                ctx.copy_text(credentials.client_id);
                self.toast = Some(("OAuth Client ID 已复制".into(), true));
            }
            Err(e) => self.toast = Some((format!("读取 OAuth Client ID 失败：{e}"), false)),
        }
    }

    pub fn copy_oauth_client_secret(&mut self, ctx: &eframe::egui::Context) {
        match ltb_host::direct_mcp::load_or_create_oauth_credentials() {
            Ok(credentials) => {
                ctx.copy_text(credentials.client_secret);
                self.toast = Some(("OAuth Client Secret 已复制".into(), true));
            }
            Err(e) => self.toast = Some((format!("读取 OAuth Client Secret 失败：{e}"), false)),
        }
    }

    pub fn copy_oauth_setup(&mut self, ctx: &eframe::egui::Context) {
        let credentials = match ltb_host::direct_mcp::load_or_create_oauth_credentials() {
            Ok(credentials) => credentials,
            Err(e) => {
                self.toast = Some((format!("读取 OAuth 凭据失败：{e}"), false));
                return;
            }
        };
        let endpoints = match ltb_host::direct_mcp::oauth_endpoint_lines(&self.direct_mcp_config) {
            Ok(endpoints) => endpoints,
            Err(e) => {
                self.toast = Some((format!("生成 OAuth 配置失败：{e}"), false));
                return;
            }
        };
        let mut text = String::new();
        for (name, value) in endpoints {
            text.push_str(&format!("{name}: {value}\n"));
        }
        text.push_str(&format!("Client ID: {}\n", credentials.client_id));
        text.push_str(&format!("Client Secret: {}\n", credentials.client_secret));
        text.push_str("Token endpoint auth: client_secret_post (client_secret_basic 也支持)\n");
        text.push_str("Scopes: mcp offline_access\n");
        text.push_str("Registration URL: 留空（使用用户自定义 OAuth 客户端）\n");
        ctx.copy_text(text);
        self.toast = Some(("完整 OAuth 配置已复制".into(), true));
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
