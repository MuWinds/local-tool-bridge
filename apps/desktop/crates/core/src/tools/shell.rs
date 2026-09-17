//! `shell.exec` — run a command and capture its output.
//!
//! The caller may choose the shell backend explicitly. On Windows we support
//! PowerShell, Git Bash, WSL, and the legacy cmd.exe backend. Each invocation
//! starts a fresh shell process; use `cwd` rather than relying on shell state.
//!
//! The real guardrails live in `policy`: a destructive-command denylist that no
//! rule can override, and a default `ask` verdict. This module only adds
//! resource limits (timeout, output cap) and environment hygiene.

use std::process::Stdio;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::AsyncReadExt;

use super::{
    clamp_u64, optional_str, optional_u64, required_str, Tool, ToolContext, ToolDescriptor,
    ToolOutput,
};
use crate::error::{BridgeError, Result};

const MAX_CAPTURE_BYTES: usize = 512 * 1024;

/// `shell.exec`
pub struct Exec;

/// Shell backends exposed to the tool caller.
///
/// The names intentionally match the terminology used by the DSH
/// `dsh-bash-terminal` plugin so clients can present the same dropdown/enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShellKind {
    PowerShell,
    GitBash,
    Wsl,
    Cmd,
}

impl ShellKind {
    fn parse(value: Option<&str>) -> Result<Self> {
        match value.unwrap_or_else(|| if cfg!(windows) { "powershell" } else { "sh" }) {
            "powershell" | "pwsh" => Ok(Self::PowerShell),
            "gitbash" | "git-bash" | "git_bash" => Ok(Self::GitBash),
            "wsl" => Ok(Self::Wsl),
            "cmd" | "cmd.exe" => Ok(Self::Cmd),
            "sh" if !cfg!(windows) => Ok(Self::Cmd),
            other => Err(BridgeError::invalid_params(format!(
                "Unsupported shell `{other}`. Supported shells: powershell, gitbash, wsl, cmd"
            ))),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::PowerShell => "powershell",
            Self::GitBash => "gitbash",
            Self::Wsl => "wsl",
            Self::Cmd => "cmd",
        }
    }

    fn command_line(
        self,
        command: &str,
        distro: Option<&str>,
    ) -> Result<(&'static str, Vec<String>)> {
        match self {
            Self::PowerShell => Ok((
                if cfg!(windows) { "pwsh.exe" } else { "pwsh" },
                vec![
                    "-NoLogo".into(),
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-Command".into(),
                    command.into(),
                ],
            )),
            Self::GitBash => {
                if !cfg!(windows) {
                    return Err(BridgeError::invalid_params(
                        "Git Bash is only available on Windows",
                    ));
                }
                Ok(("bash.exe", vec!["-lc".into(), command.into()]))
            }
            Self::Wsl => {
                if !cfg!(windows) {
                    return Err(BridgeError::invalid_params(
                        "WSL is only available on Windows",
                    ));
                }
                let mut args = Vec::new();
                if let Some(distro) = distro {
                    if distro.trim().is_empty() {
                        return Err(BridgeError::invalid_params(
                            "`distro` must not be empty when provided",
                        ));
                    }
                    args.push("-d".into());
                    args.push(distro.into());
                }
                args.extend(["-e".into(), "bash".into(), "-lc".into(), command.into()]);
                Ok(("wsl.exe", args))
            }
            Self::Cmd => {
                if !cfg!(windows) {
                    return Err(BridgeError::invalid_params(
                        "cmd.exe is only available on Windows",
                    ));
                }
                Ok(("cmd.exe", vec!["/C".into(), command.into()]))
            }
        }
    }
}

#[async_trait::async_trait]
impl Tool for Exec {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            name: "shell.exec".into(),
            summary: "Run a shell command and capture its output".into(),
            description: "Executes a command using the selected shell backend. On Windows the available backends are PowerShell, Git Bash, WSL, and cmd.exe. Each invocation starts a fresh shell. The host enforces a timeout and a command denylist; every invocation requires approval unless the user has allowlisted the exact command.".into(),
            category: "shell".into(),
            mutating: true,
            default_effect: super::DefaultEffect::Ask,
            latency_hint: "slow".into(),
            input_schema: super::ObjectSchema {
                schema_type: "object".into(),
                properties: serde_json::from_value(json!({
                    "command": { "type": "string", "description": "Command line to execute" },
                    "cwd": { "type": "string", "description": "Absolute working directory" },
                    "timeoutMs": { "type": "integer", "minimum": 100, "maximum": 600000, "default": 60000 },
                    "stdin": { "type": "string", "description": "Text piped to the process's stdin" },
                    "env": { "type": "object", "description": "Extra environment variables" }
                }))
                .expect("schema must be an object"),
                required: vec!["command".into()],
            },
        }
    }

    async fn execute(&self, arguments: Value, context: &ToolContext<'_>) -> Result<ToolOutput> {
        let started = Instant::now();
        let command = required_str(&arguments, "command")?;

        if command.trim().is_empty() {
            return Err(BridgeError::invalid_params("`command` must not be empty"));
        }

        let shell = ShellKind::parse(Some(context.policy.default_shell()))?;
        let distro: Option<String> = None;

        let cwd = match optional_str(&arguments, "cwd") {
            Some(raw) => Some(context.policy.sandbox().resolve(&raw, true)?),
            None => context.policy.sandbox().roots().first().cloned(),
        };

        let timeout_ms = clamp_u64(
            optional_u64(&arguments, "timeoutMs", context.policy.default_timeout_ms()),
            100,
            600_000,
        );

        let (program, args) = shell.command_line(&command, distro.as_deref())?;
        let mut process = tokio::process::Command::new(program);
        process
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        if let Some(cwd) = &cwd {
            process.current_dir(cwd);
        }

        if let Some(extra) = arguments.get("env").and_then(Value::as_object) {
            for (key, value) in extra {
                if let Some(value) = value.as_str() {
                    process.env(key, value);
                }
            }
        }

        let mut child = process
            .spawn()
            .map_err(|error| BridgeError::from_io("Failed to spawn shell", error))?;

        if let Some(input) = optional_str(&arguments, "stdin") {
            if let Some(mut stdin) = child.stdin.take() {
                use tokio::io::AsyncWriteExt;
                let _ = stdin.write_all(input.as_bytes()).await;
                let _ = stdin.shutdown().await;
            }
        } else {
            drop(child.stdin.take());
        }

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let collect = async {
            let mut out = Vec::new();
            let mut err = Vec::new();
            if let Some(handle) = stdout {
                let _ = handle
                    .take(MAX_CAPTURE_BYTES as u64)
                    .read_to_end(&mut out)
                    .await;
            }
            if let Some(handle) = stderr {
                let _ = handle
                    .take(MAX_CAPTURE_BYTES as u64)
                    .read_to_end(&mut err)
                    .await;
            }
            let status = child.wait().await;
            (out, err, status)
        };

        let (stdout_bytes, stderr_bytes, status) =
            match tokio::time::timeout(Duration::from_millis(timeout_ms), collect).await {
                Ok(value) => value,
                Err(_) => {
                    let _ = child.kill().await;
                    return Ok(ToolOutput::error(format!(
                    "Command timed out after {timeout_ms} ms and was terminated:\n[{}] {command}",
                    shell.name()
                )));
                }
            };

        let status =
            status.map_err(|error| BridgeError::from_io("Failed to await shell", error))?;
        let stdout_text = String::from_utf8_lossy(&stdout_bytes).to_string();
        let stderr_text = String::from_utf8_lossy(&stderr_bytes).to_string();

        let exit_code = status.code();
        let mut body = String::new();
        body.push_str(&format!("[{}] $ {command}\n", shell.name()));
        if let Some(distro) = &distro {
            body.push_str(&format!("  (distro: {distro})\n"));
        }
        if let Some(cwd) = &cwd {
            body.push_str(&format!("  (cwd: {})\n", cwd.display()));
        }
        body.push_str(&format!(
            "exit: {}\n",
            exit_code
                .map(|c| c.to_string())
                .unwrap_or_else(|| "terminated by signal".into())
        ));

        if !stdout_text.is_empty() {
            body.push_str("\n--- stdout ---\n");
            body.push_str(&stdout_text);
            if !body.ends_with('\n') {
                body.push('\n');
            }
        }
        if !stderr_text.is_empty() {
            body.push_str("\n--- stderr ---\n");
            body.push_str(&stderr_text);
            if !body.ends_with('\n') {
                body.push('\n');
            }
        }

        let captured = stdout_bytes.len() + stderr_bytes.len();
        let truncated = captured >= MAX_CAPTURE_BYTES;

        Ok(ToolOutput {
            content: vec![super::ContentBlock::text(body)],
            is_error: exit_code.map(|code| code != 0).unwrap_or(true),
            truncated,
            original_bytes: Some(captured),
            duration_ms: Some(started.elapsed().as_millis() as u64),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::ShellKind;

    #[test]
    fn parses_supported_shells() {
        assert_eq!(
            ShellKind::parse(Some("powershell")).unwrap(),
            ShellKind::PowerShell
        );
        assert_eq!(
            ShellKind::parse(Some("gitbash")).unwrap(),
            ShellKind::GitBash
        );
        assert_eq!(ShellKind::parse(Some("wsl")).unwrap(), ShellKind::Wsl);
        assert_eq!(ShellKind::parse(Some("cmd")).unwrap(), ShellKind::Cmd);
    }

    #[test]
    fn rejects_unknown_shell() {
        assert!(ShellKind::parse(Some("fish")).is_err());
    }

    #[test]
    fn builds_gitbash_command() {
        if cfg!(windows) {
            let (program, args) = ShellKind::GitBash.command_line("git status", None).unwrap();
            assert_eq!(program, "bash.exe");
            assert_eq!(args, vec!["-lc", "git status"]);
        }
    }

    #[test]
    fn builds_wsl_command_with_distro() {
        if cfg!(windows) {
            let (program, args) = ShellKind::Wsl
                .command_line("ls -la", Some("Ubuntu"))
                .unwrap();
            assert_eq!(program, "wsl.exe");
            assert_eq!(args, vec!["-d", "Ubuntu", "-e", "bash", "-lc", "ls -la"]);
        }
    }
}
