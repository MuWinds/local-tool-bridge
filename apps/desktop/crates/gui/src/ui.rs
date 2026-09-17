//! Window rendering.

use crate::app::{BridgeApp, Tab};
use eframe::egui::{self, Color32, RichText};
use ltb_core::policy::{Effect, ToolSchemaProfile};
use ltb_core::tools::DefaultEffect;

pub fn draw(app: &mut BridgeApp, ctx: &egui::Context) {
    draw_approval_modal(app, ctx);
    egui::TopBottomPanel::top("tabs").show(ctx, |ui| {
        ui.horizontal(|ui| {
            ui.heading("Local Tool Bridge");
            ui.label(RichText::new("本地工具桥接控制台").weak().small());
            ui.separator();
            for (tab, label) in [
                (Tab::Status, "状态"),
                (Tab::Tools, "工具与策略"),
                (Tab::Audit, "审计日志"),
                (Tab::Setup, "安装 / MCP"),
            ] {
                if ui.selectable_label(app.tab == tab, label).clicked() {
                    app.tab = tab;
                }
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let running = app.http_address.is_some()
                    || app.websocket_address.is_some()
                    || app.mcp_address.is_some();
                let (label, color) = if running {
                    ("● 运行中", Color32::from_rgb(26, 156, 98))
                } else {
                    ("● 未监听", Color32::from_rgb(192, 57, 43))
                };
                ui.label(RichText::new(label).color(color).strong());
            });
        });
    });
    egui::TopBottomPanel::bottom("status").show(ctx, |ui| {
        ui.horizontal(|ui| {
            if let Some((message, ok)) = &app.toast {
                let color = if *ok {
                    Color32::from_rgb(26, 156, 98)
                } else {
                    Color32::from_rgb(192, 57, 43)
                };
                ui.label(RichText::new(message).color(color));
            } else {
                ui.label(RichText::new("提示：需确认的工具调用会在此窗口弹出审批请求。").weak());
            }
        });
    });
    egui::CentralPanel::default().show(ctx, |ui| {
        egui::ScrollArea::vertical().show(ui, |ui| match app.tab {
            Tab::Status => draw_status(app, ui),
            Tab::Tools => draw_tools(app, ui),
            Tab::Audit => draw_audit(app, ui),
            Tab::Setup => {
                draw_setup(app, ui);
                draw_tunnel_setup(app, ui);
            }
        });
    });
}

fn draw_tunnel_setup(app: &mut BridgeApp, ui: &mut egui::Ui) {
    ui.add_space(16.0);
    ui.separator();
    ui.heading("OpenAI Secure MCP Tunnel");
    ui.label(RichText::new("使用 Rust 原生 Secure MCP Tunnel 核心，把本机 MCP /mcp 通过出站 HTTPS 接到 OpenAI；不再依赖 tunnel-client.exe。").weak());
    ui.checkbox(
        &mut app.tunnel_config.enabled,
        "启动 GUI 时自动运行 Rust Tunnel",
    );
    egui::Grid::new("secure-tunnel")
        .num_columns(2)
        .spacing([10.0, 6.0])
        .show(ui, |ui| {
            ui.label("Control Plane");
            ui.text_edit_singleline(&mut app.tunnel_config.control_plane_base_url);
            ui.end_row();
            ui.label("Tunnel ID");
            ui.text_edit_singleline(&mut app.tunnel_config.tunnel_id);
            ui.end_row();
            ui.label("API Key 文件");
            ui.label(if app.tunnel_config.api_key_file.is_empty() {
                ltb_host::tunnel::default_api_key_path()
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|| "不可用".into())
            } else {
                app.tunnel_config.api_key_file.clone()
            });
            ui.end_row();
            ui.label("启动等待");
            ui.text_edit_singleline(&mut app.tunnel_config.startup_wait_timeout);
            ui.end_row();
            ui.label("Poll 超时");
            ui.text_edit_singleline(&mut app.tunnel_config.poll_timeout);
            ui.end_row();
        });
    ui.label(
        RichText::new("Runtime API Key（只写入本机文件，不显示已有值）")
            .weak()
            .small(),
    );
    ui.add(
        egui::TextEdit::singleline(&mut app.tunnel_api_key)
            .password(true)
            .desired_width(420.0),
    );
    ui.horizontal(|ui| {
        if ui.button("保存 Tunnel API Key").clicked() {
            app.save_tunnel_api_key();
        }
        if ui.button("保存 Tunnel 配置").clicked() {
            app.save_tunnel_config();
        }
    });
    if let Some(path) = ltb_host::tunnel::config_path() {
        ui.label(
            RichText::new(format!("Tunnel 配置：{}", path.display()))
                .monospace()
                .small(),
        );
    }
}

fn draw_status(app: &mut BridgeApp, ui: &mut egui::Ui) {
    ui.heading("运行状态");
    ui.label(RichText::new("本地工具、MCP Gateway 与安全策略").weak());
    ui.add_space(10.0);
    egui::Grid::new("addresses")
        .num_columns(2)
        .spacing([16.0, 6.0])
        .show(ui, |ui| {
            ui.label("HTTP");
            ui.label(
                app.http_address
                    .as_deref()
                    .map(|a| format!("http://{a}/rpc"))
                    .unwrap_or_else(|| "未启动".into()),
            );
            ui.end_row();
            ui.label("WebSocket");
            ui.label(
                app.websocket_address
                    .as_deref()
                    .map(|a| format!("ws://{a}"))
                    .unwrap_or_else(|| "未启动".into()),
            );
            ui.end_row();
            ui.label("MCP");
            ui.label(
                app.mcp_address
                    .as_deref()
                    .map(|a| format!("http://{a}/mcp"))
                    .unwrap_or_else(|| "未启动".into()),
            );
            ui.end_row();
            ui.label("Native Messaging");
            ui.label(if app.native_registered {
                "已注册"
            } else {
                "未注册"
            });
            ui.end_row();
            ui.label("Secure MCP Tunnel");
            ui.label(if app.tunnel_process.is_some() {
                "已运行"
            } else if app.tunnel_config.enabled {
                "已启用但未运行"
            } else {
                "未启用"
            });
            ui.end_row();
        });
    ui.add_space(12.0);
    ui.label(RichText::new("连接令牌").strong());
    ui.horizontal(|ui| {
        let mut shown = app.secret.clone();
        ui.add(
            egui::TextEdit::singleline(&mut shown)
                .desired_width(360.0)
                .font(egui::TextStyle::Monospace)
                .interactive(false),
        );
        if ui.button("复制").clicked() {
            app.copy_secret(ui.ctx());
            app.toast = Some(("令牌已复制".into(), true));
        }
    });
    ui.add_space(12.0);
    ui.separator();
    ui.label(RichText::new("当前策略概览").strong());
    let mut counts = (0usize, 0usize, 0usize);
    for tool in app.dispatcher.registry().descriptors() {
        match app.effect_for(&tool.name) {
            Effect::Allow => counts.0 += 1,
            Effect::Ask => counts.1 += 1,
            Effect::Deny => counts.2 += 1,
        }
    }
    ui.label(format!(
        "允许 {} 个 · 需确认 {} 个 · 禁止 {} 个",
        counts.0, counts.1, counts.2
    ));
    if app.policy.roots.is_empty() {
        ui.label(RichText::new("⚠ 尚未设置工作目录").color(Color32::from_rgb(217, 119, 6)));
    } else {
        ui.label(format!("工作目录：{}", app.policy.roots.join("、")));
    }
    if app.policy.allowed_hosts.is_empty() {
        ui.label(RichText::new("⚠ 尚未设置 HTTP 白名单").color(Color32::from_rgb(217, 119, 6)));
    }
}

fn draw_tools(app: &mut BridgeApp, ui: &mut egui::Ui) {
    ui.heading("工具权限");
    ui.label(RichText::new("选择模型看到的工具 Schema，并统一经过策略、审批与审计。").weak());
    ui.group(|ui| {
        ui.label(RichText::new("工具 Schema").strong());
        let before=app.policy.tool_schema;
        egui::ComboBox::from_id_salt("tool-schema-profile").selected_text(match app.policy.tool_schema{ToolSchemaProfile::Bridge=>"Local Tool Bridge",ToolSchemaProfile::Codex=>"Codex Rust Compatible"}).show_ui(ui,|ui|{
            ui.selectable_value(&mut app.policy.tool_schema,ToolSchemaProfile::Bridge,"Local Tool Bridge");
            ui.selectable_value(&mut app.policy.tool_schema,ToolSchemaProfile::Codex,"Codex Rust Compatible");
        });
        if app.policy.tool_schema!=before { app.dispatcher.registry().set_schema_profile(match app.policy.tool_schema{ToolSchemaProfile::Bridge=>ltb_core::tools::ToolSchemaProfile::Bridge,ToolSchemaProfile::Codex=>ltb_core::tools::ToolSchemaProfile::Codex}); app.dirty=true; }
        ui.label(match app.policy.tool_schema{ToolSchemaProfile::Bridge=>"使用项目原生的 fs.* / shell.* / http.* 工具。",ToolSchemaProfile::Codex=>"只向模型暴露 Codex 风格的 exec / unified_exec / apply_patch / list_dir / read_file；不包含 write_stdin。"});
    });
    ui.add_space(8.0);
    ui.horizontal(|ui| {
        ui.label("默认 Shell");
        let before = app.policy.default_shell.clone();
        egui::ComboBox::from_id_salt("default-shell")
            .selected_text(match app.policy.default_shell.as_str() {
                "powershell" => "PowerShell",
                "gitbash" => "Git Bash",
                "wsl" => "WSL",
                "cmd" => "Command Prompt",
                _ => "PowerShell",
            })
            .show_ui(ui, |ui| {
                ui.selectable_value(
                    &mut app.policy.default_shell,
                    "powershell".into(),
                    "PowerShell",
                );
                ui.selectable_value(&mut app.policy.default_shell, "gitbash".into(), "Git Bash");
                ui.selectable_value(&mut app.policy.default_shell, "wsl".into(), "WSL");
                ui.selectable_value(
                    &mut app.policy.default_shell,
                    "cmd".into(),
                    "Command Prompt",
                );
            });
        if app.policy.default_shell != before {
            app.dirty = true;
        }
    });
    egui::Grid::new("tools")
        .num_columns(4)
        .striped(true)
        .spacing([12.0, 8.0])
        .show(ui, |ui| {
            for h in ["工具", "说明", "权限", "会修改"] {
                ui.label(RichText::new(h).strong());
            }
            ui.end_row();
            for tool in app.dispatcher.registry().descriptors() {
                ui.label(RichText::new(&tool.name).monospace());
                ui.label(RichText::new(&tool.summary).small());
                let mut effect = app.effect_for(&tool.name);
                egui::ComboBox::from_id_salt(format!("effect-{}", tool.name))
                    .selected_text(match effect {
                        Effect::Allow => "允许",
                        Effect::Ask => "需确认",
                        Effect::Deny => "禁止",
                    })
                    .show_ui(ui, |ui| {
                        ui.selectable_value(&mut effect, Effect::Allow, "允许");
                        ui.selectable_value(&mut effect, Effect::Ask, "需确认");
                        ui.selectable_value(&mut effect, Effect::Deny, "禁止");
                    });
                if effect != app.effect_for(&tool.name) {
                    app.set_effect(&tool.name, effect);
                }
                ui.label(if tool.mutating { "是" } else { "否" });
                ui.end_row();
            }
        });
    ui.add_space(12.0);
    ui.separator();
    ui.label(RichText::new("工作目录").strong());
    let mut remove = None;
    for (i, root) in app.policy.roots.iter().enumerate() {
        ui.horizontal(|ui| {
            ui.label(RichText::new(root).monospace());
            if ui.small_button("移除").clicked() {
                remove = Some(i);
            }
        });
    }
    if let Some(i) = remove {
        app.policy.roots.remove(i);
        app.dirty = true;
    }
    ui.horizontal(|ui| {
        ui.add(
            egui::TextEdit::singleline(&mut app.new_root)
                .desired_width(360.0)
                .hint_text("例如 C:\\Users\\me\\project"),
        );
        if ui.button("添加").clicked() && !app.new_root.trim().is_empty() {
            app.policy.roots.push(app.new_root.trim().into());
            app.new_root.clear();
            app.dirty = true;
        }
        if ui.button("选择文件夹…").clicked() {
            if let Some(p) = rfd::FileDialog::new().pick_folder() {
                app.policy.roots.push(p.display().to_string());
                app.dirty = true;
            }
        }
    });
    ui.add_space(12.0);
    ui.separator();
    ui.label(RichText::new("HTTP 白名单").strong());
    let mut remove_host = None;
    for (i, host) in app.policy.allowed_hosts.iter().enumerate() {
        ui.horizontal(|ui| {
            ui.label(RichText::new(host).monospace());
            if ui.small_button("移除").clicked() {
                remove_host = Some(i);
            }
        });
    }
    if let Some(i) = remove_host {
        app.policy.allowed_hosts.remove(i);
        app.dirty = true;
    }
    ui.horizontal(|ui| {
        ui.add(
            egui::TextEdit::singleline(&mut app.new_host)
                .desired_width(360.0)
                .hint_text("例如 api.github.com"),
        );
        if ui.button("添加").clicked() && !app.new_host.trim().is_empty() {
            app.policy.allowed_hosts.push(app.new_host.trim().into());
            app.new_host.clear();
            app.dirty = true;
        }
    });
    if ui
        .checkbox(
            &mut app.policy.allow_private_network,
            "允许访问本机与局域网地址",
        )
        .changed()
    {
        app.dirty = true;
    }
    if ui
        .add_enabled(app.dirty, egui::Button::new("保存策略"))
        .clicked()
    {
        app.save_policy();
    }
}

fn draw_audit(app: &mut BridgeApp, ui: &mut egui::Ui) {
    ui.heading("审计日志");
    if app.audit_entries.is_empty() {
        ui.label(RichText::new("暂无记录").weak());
        return;
    }
    egui::Grid::new("audit")
        .num_columns(4)
        .striped(true)
        .spacing([12.0, 6.0])
        .show(ui, |ui| {
            for h in ["时间", "工具", "结果", "参数"] {
                ui.label(RichText::new(h).strong());
            }
            ui.end_row();
            for entry in &app.audit_entries {
                let time = entry
                    .timestamp
                    .split('T')
                    .nth(1)
                    .unwrap_or(&entry.timestamp)
                    .trim_end_matches('Z');
                ui.label(RichText::new(time).monospace().small());
                ui.label(RichText::new(&entry.tool).monospace().small());
                let label = match entry.outcome {
                    ltb_core::audit::AuditOutcome::Allowed => "允许",
                    ltb_core::audit::AuditOutcome::Approved => "已批准",
                    ltb_core::audit::AuditOutcome::Denied => "已拒绝",
                    ltb_core::audit::AuditOutcome::Rejected => "用户拒绝",
                    ltb_core::audit::AuditOutcome::Expired => "超时",
                    ltb_core::audit::AuditOutcome::Failed => "失败",
                };
                ui.label(label);
                let s = serde_json::to_string(&entry.arguments).unwrap_or_default();
                ui.label(
                    RichText::new(s.chars().take(120).collect::<String>())
                        .monospace()
                        .small(),
                );
                ui.end_row();
            }
        });
}

fn draw_setup(app: &mut BridgeApp, ui: &mut egui::Ui) {
    ui.heading("MCP 服务器");
    ui.label(RichText::new("在这里添加由 local-tool-bridge 启动的本地 stdio MCP Server。配置写入用户配置目录的 mcp.json。").weak());
    ui.add_space(8.0);
    let names: Vec<String> = app.mcp_config.servers.keys().cloned().collect();
    if names.is_empty() {
        ui.label(RichText::new("暂无 MCP 服务器").weak());
    }
    for name in names {
        let mut remove = false;
        let mut changed = false;
        if let Some(server) = app.mcp_config.servers.get_mut(&name) {
            ui.group(|ui| {
                ui.horizontal(|ui| {
                    ui.label(RichText::new(&name).strong());
                    changed |= ui.checkbox(&mut server.enabled, "启用").changed();
                    if ui.small_button("删除").clicked() {
                        remove = true;
                    }
                });
                ui.label(format!("{} {}", server.command, server.args.join(" ")));
                if let Some(cwd) = &server.cwd {
                    ui.label(RichText::new(format!("cwd: {cwd}")).weak().small());
                }
                egui::ComboBox::from_id_salt(format!("mcp-effect-{name}"))
                    .selected_text(match server.default_effect {
                        DefaultEffect::Allow => "默认允许",
                        DefaultEffect::Ask => "默认需确认",
                        DefaultEffect::Deny => "默认禁止",
                    })
                    .show_ui(ui, |ui| {
                        changed |= ui
                            .selectable_value(
                                &mut server.default_effect,
                                DefaultEffect::Allow,
                                "默认允许",
                            )
                            .changed();
                        changed |= ui
                            .selectable_value(
                                &mut server.default_effect,
                                DefaultEffect::Ask,
                                "默认需确认",
                            )
                            .changed();
                        changed |= ui
                            .selectable_value(
                                &mut server.default_effect,
                                DefaultEffect::Deny,
                                "默认禁止",
                            )
                            .changed();
                    });
            });
        }
        if changed {}
        if remove {
            app.mcp_config.servers.remove(&name);
        }
    }
    ui.add_space(8.0);
    ui.separator();
    ui.label(RichText::new("添加 MCP Server").strong());
    egui::Grid::new("new-mcp")
        .num_columns(2)
        .spacing([10.0, 6.0])
        .show(ui, |ui| {
            ui.label("名称");
            ui.text_edit_singleline(&mut app.new_mcp_name);
            ui.end_row();
            ui.label("Command");
            ui.text_edit_singleline(&mut app.new_mcp_command);
            ui.end_row();
            ui.label("Arguments");
            ui.text_edit_singleline(&mut app.new_mcp_args);
            ui.end_row();
            ui.label("工作目录");
            ui.text_edit_singleline(&mut app.new_mcp_cwd);
            ui.end_row();
        });
    if ui.button("添加服务器").clicked() {
        app.add_mcp_server();
    }
    ui.horizontal(|ui| {
        if ui.button("保存 mcp.json").clicked() {
            app.save_mcp_config();
        }
        if ui.button("写入客户端 MCP 配置").clicked() {
            app.export_client_mcp_config();
        }
    });
    if let Some(path) = ltb_host::mcp_servers::config_path() {
        ui.label(
            RichText::new(format!("配置文件：{}", path.display()))
                .monospace()
                .small(),
        );
    }
    ui.add_space(16.0);
    ui.separator();
    ui.heading("Native Messaging");
    ui.horizontal(|ui| {
        ui.label("扩展 ID");
        ui.add(
            egui::TextEdit::singleline(&mut app.new_host)
                .desired_width(300.0)
                .hint_text("chrome://extensions"),
        );
    });
    ui.horizontal(|ui| {
        if ui.button("注册宿主").clicked() {
            match std::env::current_exe() {
                Ok(exe) => {
                    let host = exe.with_file_name(if cfg!(windows) {
                        "ltb-host.exe"
                    } else {
                        "ltb-host"
                    });
                    match crate::install::install(&host, app.new_host.trim()) {
                        Ok(path) => {
                            app.native_registered = true;
                            app.toast = Some((format!("已注册：{}", path.display()), true));
                        }
                        Err(e) => app.toast = Some((format!("注册失败：{e}"), false)),
                    }
                }
                Err(e) => app.toast = Some((format!("无法定位程序：{e}"), false)),
            }
        }
        if ui.button("取消注册").clicked() {
            match crate::install::uninstall() {
                Ok(()) => {
                    app.native_registered = false;
                    app.toast = Some(("已取消注册".into(), true));
                }
                Err(e) => app.toast = Some((format!("取消注册失败：{e}"), false)),
            }
        }
    });
    if let Some(path) = crate::install::manifest_path() {
        ui.label(
            RichText::new(format!("宿主清单：{}", path.display()))
                .monospace()
                .small(),
        );
    }
}

fn draw_approval_modal(app: &mut BridgeApp, ctx: &egui::Context) {
    let Some(active) = &app.active_approval else {
        return;
    };
    let mut decision = None;
    egui::Window::new("工具调用请求")
        .collapsible(false)
        .resizable(false)
        .anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0])
        .show(ctx, |ui| {
            ui.set_min_width(420.0);
            ui.label(RichText::new("模型请求在你的电脑上执行以下操作：").strong());
            ui.label(RichText::new(&active.challenge.tool).monospace().size(15.0));
            ui.label(RichText::new(&active.challenge.reason).weak().small());
            egui::Frame::group(ui.style()).show(ui, |ui| {
                let args =
                    serde_json::to_string_pretty(&active.challenge.arguments).unwrap_or_default();
                egui::ScrollArea::vertical()
                    .max_height(180.0)
                    .show(ui, |ui| {
                        ui.label(RichText::new(args).monospace().small());
                    });
            });
            ui.horizontal(|ui| {
                if ui.button("拒绝").clicked() {
                    decision = Some((false, false));
                }
                if ui.button("仅本次允许").clicked() {
                    decision = Some((true, false));
                }
                if ui.button(RichText::new("始终允许").strong()).clicked() {
                    decision = Some((true, true));
                }
            });
        });
    if let Some((approved, remember)) = decision {
        app.resolve_approval(approved, remember);
    }
}
