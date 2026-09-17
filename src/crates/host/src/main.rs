//! `ltb-host` command-line entry point.
//!
//! All real logic lives in the `ltb_host` library so the GUI can embed it; this
//! file only parses arguments and wires the chosen mode together.

use std::path::PathBuf;

use clap::{Parser, Subcommand};

use ltb_host::{build_dispatcher, load_or_create_secret, load_policy, run_http, run_mcp, run_websocket};

#[derive(Parser, Debug)]
#[command(name = "ltb-host", about = "Local MCP tool bridge", version)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    /// Port for the loopback HTTP and WebSocket transports. 0 picks a free port.
    #[arg(long, default_value_t = 8788, global = true)]
    port: u16,

    /// Port for the loopback MCP transport. 0 picks a free port.
    #[arg(long, default_value_t = 8789, global = true)]
    mcp_port: u16,

    /// Path to the policy document. Defaults to the per-user config directory.
    #[arg(long, global = true)]
    policy: Option<PathBuf>,

    /// Disable the on-disk audit log.
    #[arg(long, global = true)]
    no_audit: bool,

    /// Print the bridge secret to stdout and exit.
    #[arg(long)]
    print_secret: bool,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Serve the loopback HTTP transport (default).
    Serve,
    /// Serve the loopback WebSocket transport.
    ServeWs,
    /// Serve the loopback MCP (Model Context Protocol) transport.
    ServeMcp,
    /// Print the effective policy as JSON and exit.
    DumpPolicy,
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    let cli = Cli::parse();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .with_ansi(true)
        .init();

    if cli.print_secret {
        return match load_or_create_secret() {
            Ok(secret) => {
                println!("{secret}");
                std::process::ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("failed to load the bridge secret: {error}");
                std::process::ExitCode::FAILURE
            }
        };
    }

    if let Some(Command::DumpPolicy) = cli.command {
        let policy = load_policy(cli.policy.as_ref());
        return match serde_json::to_string_pretty(&policy) {
            Ok(json) => {
                println!("{json}");
                std::process::ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("failed to serialise the policy: {error}");
                std::process::ExitCode::FAILURE
            }
        };
    }

    let dispatcher = match build_dispatcher(cli.policy.clone(), !cli.no_audit).await {
        Ok(dispatcher) => dispatcher,
        Err(error) => {
            eprintln!("failed to start the bridge: {error}");
            return std::process::ExitCode::FAILURE;
        }
    };

    let command = cli.command.unwrap_or(Command::Serve);

    match command {
        Command::Serve | Command::ServeWs | Command::ServeMcp | Command::DumpPolicy => {
            let secret = match load_or_create_secret() {
                Ok(secret) => secret,
                Err(error) => {
                    eprintln!("failed to load the bridge secret: {error}");
                    return std::process::ExitCode::FAILURE;
                }
            };

            let serve_websocket = matches!(command, Command::ServeWs);
            let serve_mcp = matches!(command, Command::ServeMcp);

            let address = if serve_mcp {
                run_mcp(cli.mcp_port, dispatcher, secret.clone()).await
            } else if serve_websocket {
                run_websocket(cli.port, dispatcher, secret.clone()).await
            } else {
                run_http(cli.port, dispatcher, secret.clone()).await
            };

            let address = match address {
                Ok(address) => address,
                Err(error) => {
                    eprintln!(
                        "failed to bind the loopback socket on port {}: {error}",
                        cli.port
                    );
                    return std::process::ExitCode::FAILURE;
                }
            };

            // Printed once at startup so a user running the host by hand can
            // paste the token into an MCP client. Never logged by a transport.
            if serve_mcp {
                println!("ltb-host MCP listening on http://{address}/mcp");
            } else if serve_websocket {
                println!("ltb-host listening on ws://{address}");
            } else {
                println!("ltb-host listening on http://{address}/rpc");
            }
            println!("bridge secret: {secret}");
            println!("press Ctrl+C to stop");

            if let Err(error) = tokio::signal::ctrl_c().await {
                tracing::error!(%error, "failed to listen for Ctrl+C");
                return std::process::ExitCode::FAILURE;
            }
            tracing::info!("shutting down");
        }
    }

    std::process::ExitCode::SUCCESS
}
