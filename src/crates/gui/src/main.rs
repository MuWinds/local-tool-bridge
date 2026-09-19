//! `ltb-gui` — the bridge control panel.
//!
//! Starts the dispatcher on a background tokio runtime, brings up the loopback
//! transports, and opens a native egui window. The window is the only place a
//! human can answer an approval prompt, so closing it flips the approver to
//! non-interactive and every subsequent `ask` is denied.

use std::sync::Arc;
use std::time::Duration;

use app::{BridgeApp, BridgeAppInit};
use approver::GuiApprover;

mod app;
mod approver;
mod fonts;
mod ui;

/// How long an approval prompt stays open before it is denied.
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(180);

/// The loopback ports to try, in order.
///
/// A second instance would otherwise fail to bind and leave the user with a
/// window that silently does nothing.
const PORTS: &[u16] = &[8788, 8789, 8790, 8791];

fn main() -> eframe::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    // Only one control panel may run: two would fight over the ports and show
    // two approval dialogs for one call.
    let instance = match single_instance::SingleInstance::new("local-tool-bridge-gui") {
        Ok(instance) => instance,
        Err(error) => {
            eprintln!("failed to initialise the single-instance guard: {error}");
            return Ok(());
        }
    };

    if !instance.is_single() {
        eprintln!("The bridge control panel is already running.");
        return Ok(());
    }

    // A multi-threaded runtime because tool calls are concurrent: a slow shell
    // command must not block a filesystem read.
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(4)
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("failed to start the async runtime: {error}");
            return Ok(());
        }
    };

    let (approver, approval_rx) = GuiApprover::new(APPROVAL_TIMEOUT);

    // Everything the window needs, resolved before the first frame so the UI
    // never shows a half-initialised state.
    let (
        dispatcher,
        secret,
        http_address,
        websocket_address,
        mcp_address,
        direct_mcp_address,
        direct_mcp_config,
        tunnel_process,
    ) = runtime.block_on(async {
        let dispatcher = match ltb_host::build_dispatcher(None, true).await {
            Ok(dispatcher) => dispatcher,
            Err(error) => {
                eprintln!("failed to start the bridge: {error}");
                std::process::exit(1);
            }
        };

        // Install the approver before any transport starts, so a call arriving
        // during startup still reaches a human.
        dispatcher.set_approver(approver.clone()).await;

        let secret = ltb_host::load_or_create_secret().unwrap_or_default();

        let mut http_address = None;
        let mut websocket_address = None;
        let mut mcp_address = None;
        let mut direct_mcp_address = None;
        let direct_mcp_config = ltb_host::direct_mcp::load_config();
        let mut tunnel_process = None;

        for port in PORTS {
            if http_address.is_none() {
                if let Ok(address) =
                    ltb_host::run_http(*port, dispatcher.clone(), secret.clone()).await
                {
                    http_address = Some(address.to_string());
                    tracing::info!(%address, "HTTP transport listening");
                }
            }
            if websocket_address.is_none() {
                // The WebSocket transport is offered alongside HTTP so a client
                // that needs server push has somewhere to connect.
                if let Ok(address) =
                    ltb_host::run_websocket(*port, dispatcher.clone(), secret.clone()).await
                {
                    websocket_address = Some(address.to_string());
                }
            }
            if mcp_address.is_none() {
                // The MCP transport lets ChatGPT/Codex reach the same tools
                // through OpenAI's Secure MCP Tunnel.
                if let Ok(address) =
                    ltb_host::run_mcp(*port, dispatcher.clone(), secret.clone()).await
                {
                    mcp_address = Some(address.to_string());
                    tracing::info!(%address, "MCP transport listening");
                }
            }
            if http_address.is_some() && websocket_address.is_some() && mcp_address.is_some() {
                break;
            }
        }

        if direct_mcp_config.enabled {
            match ltb_host::run_configured_direct_mcp(&direct_mcp_config, dispatcher.clone()).await
            {
                Ok(running) => {
                    direct_mcp_address =
                        Some(format!("http://{}{}", running.address, running.mcp_path));
                    tracing::info!(
                        address = %running.address,
                        "Direct Remote MCP transport listening"
                    );
                }
                Err(error) => {
                    tracing::error!(%error, "failed to start Direct Remote MCP");
                }
            }
        }

        if let Some(mcp_address_value) = mcp_address.as_deref() {
            let tunnel_config = ltb_host::tunnel::load_config();
            if tunnel_config.enabled {
                let bridge_secret_path = ltb_core::config_dir().map(|dir| dir.join("secret"));
                if let Some(secret_path) = bridge_secret_path {
                    match ltb_host::tunnel::TunnelProcess::start(
                        &tunnel_config,
                        &format!("http://{mcp_address_value}/mcp"),
                        &secret_path,
                    )
                    .await
                    {
                        Ok(process) => tunnel_process = Some(process),
                        Err(error) => {
                            tracing::error!(%error, "failed to start Secure MCP Tunnel client")
                        }
                    }
                }
            }
        }

        (
            dispatcher,
            secret,
            http_address,
            websocket_address,
            mcp_address,
            direct_mcp_address,
            direct_mcp_config,
            tunnel_process,
        )
    });

    let handle = runtime.handle().clone();

    let options = eframe::NativeOptions {
        viewport: eframe::egui::ViewportBuilder::default()
            .with_inner_size([880.0, 660.0])
            .with_min_inner_size([640.0, 480.0])
            .with_title("Local Tool Bridge — 本地工具桥接"),
        ..Default::default()
    };

    eframe::run_native(
        "Local Tool Bridge — 本地工具桥接",
        options,
        Box::new(move |cc| {
            // Must run before the first frame: the default font set has no CJK
            // coverage, so without this every Chinese label renders as a box.
            fonts::install(&cc.egui_ctx);

            let app = BridgeApp::new(BridgeAppInit {
                runtime: handle,
                dispatcher,
                secret,
                http_address,
                websocket_address,
                mcp_address,
                direct_mcp_address,
                direct_mcp_config,
                tunnel_process,
            });

            Ok(Box::new(GuiFrame {
                app,
                approvals: approval_rx,
                approver,
                runtime: Some(runtime),
            }))
        }),
    )
}

/// Wraps the app so `eframe` can drive it, and so the runtime outlives the
/// window instead of being dropped at the end of `main`.
struct GuiFrame {
    app: BridgeApp,
    approvals: tokio::sync::mpsc::UnboundedReceiver<approver::PendingApproval>,
    approver: Arc<GuiApprover>,
    /// Kept alive for the process lifetime; dropping it would stop the host.
    runtime: Option<tokio::runtime::Runtime>,
}

impl eframe::App for GuiFrame {
    fn update(&mut self, ctx: &eframe::egui::Context, _frame: &mut eframe::Frame) {
        // Drains approvals and refreshes the audit view.
        self.app.poll(&mut self.approvals);

        ui::draw(&mut self.app, ctx);

        // Repaint while a prompt is waiting, so an expiring approval does not sit
        // on screen looking actionable.
        if self.app.active_approval.is_some() {
            ctx.request_repaint_after(Duration::from_millis(250));
        }
    }

    fn on_exit(&mut self, _gl: Option<&eframe::glow::Context>) {
        // With no window there is nobody to ask, so every later approval must be
        // denied rather than silently allowed. This is the fail-closed edge, and
        // it matters because the transports keep running after the UI is gone.
        let approver = self.approver.clone();
        if let Some(runtime) = &self.runtime {
            runtime.block_on(async move {
                approver.set_interactive(false).await;
            });
            if let Some(tunnel) = self.app.tunnel_process.as_mut() {
                runtime.block_on(tunnel.stop());
            }
        }
        tracing::info!("window closed; approvals will now be denied");
    }
}
