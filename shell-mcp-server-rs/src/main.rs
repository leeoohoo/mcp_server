mod mcp;
mod shell;
mod utils;

use crate::mcp::McpServer;
use crate::shell::{execute_shell, ShellExecOptions};
use crate::utils::{clamp_number, format_bytes, get_command_root, is_subpath, normalize_id, normalize_name, parse_args, parse_csv, resolve_within_root};
use serde_json::json;
use std::env;
use std::path::PathBuf;

fn main() {
    let argv: Vec<String> = env::args().skip(1).collect();
    let args = parse_args(&argv);
    if args.flags.contains("help") || args.flags.contains("h") {
        print_help();
        return;
    }

    let env_name = env::var("MCP_SERVER_NAME").ok();
    let server_name = normalize_name(
        args.values
            .get("name")
            .or(env_name.as_ref())
            .map(String::as_str)
            .unwrap_or("shell_mcp"),
        "shell_mcp",
    );

    let env_root = env::var("MCP_WORKSPACE_ROOT").ok();
    let workspace_root = normalize_id(
        args.values
            .get("root")
            .or_else(|| args.values.get("workspace"))
            .or(env_root.as_ref()),
    );
    let workspace_root = if workspace_root.is_empty() {
        env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else {
        PathBuf::from(workspace_root)
    };

    let env_timeout = env::var("MCP_SHELL_TIMEOUT_MS").ok();
    let default_timeout_ms = clamp_number(
        args.values
            .get("timeout-ms")
            .or_else(|| args.values.get("timeout"))
            .or(env_timeout.as_ref()),
        1000,
        60 * 60 * 1000,
        5 * 60_000,
    );
    let env_max_output = env::var("MCP_SHELL_MAX_OUTPUT_BYTES").ok();
    let max_output_bytes = clamp_number(
        args.values
            .get("max-output-bytes")
            .or(env_max_output.as_ref()),
        1024,
        50 * 1024 * 1024,
        5 * 1024 * 1024,
    );
    let env_allow = env::var("MCP_SHELL_ALLOW_CMDS").ok();
    let env_deny = env::var("MCP_SHELL_DENY_CMDS").ok();
    let allow_commands = parse_csv(args.values.get("allow-commands").or(env_allow.as_ref()));
    let deny_commands = parse_csv(args.values.get("deny-commands").or(env_deny.as_ref()));

    let mut server = McpServer::new(server_name.clone(), "0.1.0");
    let workspace_note = format!(
        "Workspace root: {}. Paths must stay inside this directory.",
        workspace_root.display()
    );
    let allow_note = if allow_commands.is_empty() {
        "Allowed command roots: any.".to_string()
    } else {
        format!("Allowed command roots: {}", allow_commands.join(", "))
    };
    let deny_note = if deny_commands.is_empty() {
        "Denied command roots: none.".to_string()
    } else {
        format!("Denied command roots: {}", deny_commands.join(", "))
    };

    server.register_tool(
        "run_shell",
        &format!(
            "Execute a shell command and return structured output with stdout/stderr separated.\nMax combined output: {}.\nDefault inactivity timeout: {} ms.\n{}\n{}\n{}",
            format_bytes(max_output_bytes),
            default_timeout_ms,
            allow_note,
            deny_note,
            workspace_note
        ),
        json!({
            "type": "object",
            "properties": {
                "command": { "type": "string", "minLength": 1 },
                "dir_path": { "type": "string" },
                "description": { "type": "string" },
                "timeout_ms": { "type": "integer", "minimum": 1 },
                "max_output_bytes": { "type": "integer", "minimum": 1 }
            },
            "required": ["command"]
        }),
        Box::new(move |args| {
            let command = args
                .get("command")
                .and_then(|v| v.as_str())
                .ok_or("command is required".to_string())?;
            let command_root = get_command_root(command);
            if deny_commands.contains(&command_root) {
                return Err(format!("Command root is denied: {command_root}"));
            }
            if !allow_commands.is_empty() && !allow_commands.contains(&command_root) {
                return Err(format!(
                    "Command root is not in allowlist: {command_root}"
                ));
            }

            let dir_path = args.get("dir_path").and_then(|v| v.as_str());
            let resolved_root = workspace_root.clone();
            let cwd = if let Some(dir) = dir_path {
                resolve_within_root(&resolved_root, dir)
            } else {
                resolved_root.clone()
            };
            if !is_subpath(&resolved_root, &cwd) {
                return Err(format!(
                    "dir_path must be within workspace: {}",
                    resolved_root.display()
                ));
            }

            let timeout_ms = args
                .get("timeout_ms")
                .and_then(|v| v.as_i64())
                .unwrap_or(default_timeout_ms);
            let max_output = args
                .get("max_output_bytes")
                .and_then(|v| v.as_i64())
                .unwrap_or(max_output_bytes) as usize;

            let result = execute_shell(
                command,
                ShellExecOptions {
                    cwd,
                    timeout_ms,
                    max_output_bytes: max_output,
                },
            )?;

            let exit_code = match result.exit_code {
                Some(code) => json!(code),
                None => json!("(none)"),
            };
            let signal = match result.signal {
                Some(sig) => json!(sig),
                None => json!("(none)"),
            };
            let pgid = match result.pid {
                Some(pid) => json!(pid),
                None => json!("(none)"),
            };
            let payload = json!({
                "command": command,
                "directory": dir_path.unwrap_or("(root)"),
                "output": result.output,
                "stdout": result.stdout,
                "stderr": result.stderr,
                "error": result.error,
                "exit_code": exit_code,
                "signal": signal,
                "background_pids": result.background_pids,
                "pgid": pgid,
                "timed_out": result.timed_out,
                "truncated": result.truncated,
            });

            Ok(text_result(payload))
        }),
    );

    if let Err(err) = server.run_stdio() {
        eprintln!("[{server_name}] shell MCP server crashed: {err}");
        std::process::exit(1);
    }
}

fn text_result(data: serde_json::Value) -> serde_json::Value {
    let text = if data.is_string() {
        data.as_str().unwrap_or("").to_string()
    } else {
        serde_json::to_string_pretty(&data).unwrap_or_else(|_| "{}".to_string())
    };
    json!({
        "content": [
            { "type": "text", "text": text }
        ]
    })
}

fn print_help() {
    println!(
        "Usage: shell-mcp-server-rs [--name <id>] [--root <path>] [--timeout-ms <ms>] [--max-output-bytes <bytes>]\n       [--allow-commands <cmd1,cmd2>] [--deny-commands <cmd1,cmd2>]\n\nOptions:\n  --name <id>                 MCP server name (default shell_mcp)\n  --root <path>               Workspace root (default: current working directory)\n  --timeout-ms <ms>           Inactivity timeout in ms (default: 300000)\n  --max-output-bytes <bytes>  Maximum captured output (default: 5242880)\n  --allow-commands <list>     Comma-separated command roots allowlist\n  --deny-commands <list>      Comma-separated command roots denylist\n  --help                      Show help\n\nEnvironment:\n  MCP_SERVER_NAME\n  MCP_WORKSPACE_ROOT\n  MCP_SHELL_TIMEOUT_MS\n  MCP_SHELL_MAX_OUTPUT_BYTES\n  MCP_SHELL_ALLOW_CMDS\n  MCP_SHELL_DENY_CMDS"
    );
}
