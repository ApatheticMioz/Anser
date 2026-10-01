//! MCP server implementation (M2c).
//!
//! Serves three tools over stdio: `<prefix>_coworker`, `<prefix>_task`,
//! `<prefix>_server`. The tool bodies are stubs that return
//! `CallToolResult::error("not implemented until M3+")` — the real
//! dispatch/execution logic lands in M3+.
//!
//! All logging goes to stderr; stdout is reserved for JSON-RPC frames.
//!
//! The `pub` items here (tool-name constants, params structs) are the M3+
//! API surface; their fields are consumed via serde/schemars derives, so
//! dead-code warnings are suppressed at module scope.
#![allow(dead_code)]

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ListToolsResult,
    PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
};
use rmcp::serve_server;
use rmcp::service::RequestContext;
use rmcp::transport::stdio;
use rmcp::{RoleServer, ServerHandler};
use schemars::JsonSchema;
use serde::Deserialize;

/// Default tool-name prefix (matches `config::Config::tool_prefix` default).
pub const DEFAULT_TOOL_PREFIX: &str = "castor";

/// Base tool names (without prefix).
pub const TOOL_COWORKER: &str = "coworker";
pub const TOOL_TASK: &str = "task";
pub const TOOL_SERVER: &str = "server";

/// The three base tool names, in canonical order.
pub const TOOL_BASE_NAMES: [&str; 3] = [TOOL_COWORKER, TOOL_TASK, TOOL_SERVER];

/// Error message returned by every tool body until M3+ implements them.
pub const NOT_IMPLEMENTED_MSG: &str = "not implemented until M3+";

/// Input schema for the `coworker` tool.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct CoworkerParams {
    /// Task, inquiry, or architectural instruction (pure text-only).
    pub prompt: String,
    /// Working directory for filesystem and shell tools (defaults to current workspace).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Named persistent session ID (maintains KV-cache and conversation context across turns).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Per-dispatch reasoning-effort tier (xhigh | medium | low).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// Optional stdio extensions (e.g. `["uvx free-search-mcp"]`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extensions: Option<Vec<String>>,
    /// Explicit list of skill names to inject (bypasses keyword auto-matching).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<String>>,
    /// Optional verification test/benchmark command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test_command: Option<String>,
    /// Task timeout in ms.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    /// Explicit override allowing a prompt up to 2,500 chars.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_large_prompt: Option<bool>,
}

/// Input schema for the `task` tool.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct TaskParams {
    /// Task ID (required for `status` and `extend_lease`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// Action to perform (status, cancel, cancel_all, list, kill, stats, extend_lease).
    pub action: String,
}

/// Input schema for the `server` tool.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ServerParams {
    /// Lifecycle action (status, start, stop).
    pub action: String,
    /// Force stop even if a task is actively executing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
}

/// The MCP server handler.
#[derive(Debug, Clone)]
pub struct CastorMcpServer {
    /// Tool-name prefix (e.g. "castor" → "castor_coworker").
    pub prefix: String,
}

impl CastorMcpServer {
    /// Create a new server with the given tool-name prefix.
    pub fn new(prefix: impl Into<String>) -> Self {
        Self {
            prefix: prefix.into(),
        }
    }

    /// Build a prefixed tool name.
    pub fn tool_name(&self, base: &str) -> String {
        if self.prefix.is_empty() {
            base.to_string()
        } else {
            format!("{}_{}", self.prefix, base)
        }
    }

    /// Build the three `Tool` definitions with their JSON schemas.
    ///
    /// `Tool::new` takes a placeholder schema value; the real schema is set by
    /// `with_input_schema::<T>()` from the serde/schemars-derived type.
    pub fn tools(&self) -> Vec<Tool> {
        let empty = std::sync::Arc::new(serde_json::Map::new());
        vec![
            Tool::new(
                self.tool_name(TOOL_COWORKER),
                "Autonomous Senior Coworker (Castor Microkernel). Primary autonomous execution \
                 coworker with full native access to Filesystem, Shell, and Git across Windows \
                 and WSL. Executes codebase exploration, refactoring, implementation, \
                 diagnostics, live web/docs research, and git operations.",
                empty.clone(),
            )
            .with_input_schema::<CoworkerParams>(),
            Tool::new(
                self.tool_name(TOOL_TASK),
                "Manage background coworker tasks: check status, retrieve output, cancel, or \
                 list tasks.",
                empty.clone(),
            )
            .with_input_schema::<TaskParams>(),
            Tool::new(
                self.tool_name(TOOL_SERVER),
                "Manage the local vLLM engine lifecycle: check status, start, or stop the \
                 universal 245K-context vLLM server in WSL.",
                empty,
            )
            .with_input_schema::<ServerParams>(),
        ]
    }
}

impl ServerHandler for CastorMcpServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .build(),
        )
        .with_server_info(
            rmcp::model::Implementation::new("castor", env!("CARGO_PKG_VERSION"))
                .with_description("Castor: Rust MCP toolchain, proxy, and evo engine"),
        )
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, rmcp::ErrorData> {
        Ok(ListToolsResult::with_all_items(self.tools()))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, rmcp::ErrorData> {
        let name = request.name.as_ref();
        let msg = format!("{}: {NOT_IMPLEMENTED_MSG}", name);
        eprintln!("[castor-mcp] call_tool({name}) → {NOT_IMPLEMENTED_MSG}");
        let result = match name {
            n if n == self.tool_name(TOOL_COWORKER)
                || n == self.tool_name(TOOL_TASK)
                || n == self.tool_name(TOOL_SERVER) =>
            {
                CallToolResult::error(vec![ContentBlock::text(msg)])
            }
            _ => {
                return Err(rmcp::ErrorData::method_not_found::<
                    rmcp::model::CallToolRequestMethod,
                >());
            }
        };
        Ok(CallToolResponse::from(result))
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.tools().into_iter().find(|t| t.name.as_ref() == name)
    }
}

/// Serve the MCP server over stdio.
///
/// stdout carries JSON-RPC frames; all logging goes to stderr.
pub async fn serve(prefix: &str) -> Result<(), Box<dyn std::error::Error>> {
    eprintln!("[castor-mcp] serving over stdio (prefix={prefix})");
    let (stdin, stdout) = stdio();
    let server = CastorMcpServer::new(prefix);
    let running = serve_server(server, (stdin, stdout)).await?;
    running.waiting().await?;
    eprintln!("[castor-mcp] stdio closed; shutting down");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ------------------------------------------------------------------
    // In-process: tools/list parity vs manifest constants
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn list_tools_matches_manifest_constants() {
        let server = CastorMcpServer::new(DEFAULT_TOOL_PREFIX);
        let tools = server.tools();

        // Exactly three tools, in canonical order.
        assert_eq!(tools.len(), 3);
        let names: Vec<&str> = tools.iter().map(|t| t.name.as_ref()).collect();
        let expected: Vec<String> = TOOL_BASE_NAMES
            .iter()
            .map(|b| format!("{DEFAULT_TOOL_PREFIX}_{b}"))
            .collect();
        assert_eq!(
            names,
            expected,
            "tool names must match manifest constants"
        );

        // Each tool has a non-empty description and a valid input schema.
        for t in &tools {
            assert!(
                t.description.as_ref().is_some_and(|d| !d.is_empty()),
                "tool {} must have a description",
                t.name
            );
            let schema = t.input_schema.as_ref();
            assert!(
                schema.get("type").is_some(),
                "tool {} must have an input schema with a type",
                t.name
            );
        }

        // The coworker schema must declare `prompt` as required.
        let coworker = &tools[0];
        let schema = coworker.input_schema.as_ref();
        let required = schema
            .get("required")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().map(|v| v.as_str().unwrap_or("")).collect::<Vec<_>>());
        assert!(
            required.as_deref() == Some(&vec!["prompt"]),
            "coworker schema must require `prompt`, got {required:?}"
        );

        // The task schema must declare `action` as required.
        let task = &tools[1];
        let schema = task.input_schema.as_ref();
        let required = schema
            .get("required")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().map(|v| v.as_str().unwrap_or("")).collect::<Vec<_>>());
        assert!(
            required.as_deref() == Some(&vec!["action"]),
            "task schema must require `action`, got {required:?}"
        );

        // The server schema must declare `action` as required.
        let server_tool = &tools[2];
        let schema = server_tool.input_schema.as_ref();
        let required = schema
            .get("required")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().map(|v| v.as_str().unwrap_or("")).collect::<Vec<_>>());
        assert!(
            required.as_deref() == Some(&vec!["action"]),
            "server schema must require `action`, got {required:?}"
        );
    }

    // ------------------------------------------------------------------
    // stdio purity: spawn the binary, every stdout line is JSON-RPC
    // ------------------------------------------------------------------

    async fn spawn_and_handshake(
        args: &[&str],
        extra_env: &[(&str, &str)],
    ) -> (
        tokio::process::Child,
        tokio::io::BufReader<tokio::process::ChildStdout>,
        tokio::process::ChildStdin,
    ) {
        // Point at the real `castor` binary (not the test-harness binary that
        // `current_exe()` would return inside a unit test).
        let bin = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/debug/castor");
        let mut cmd = tokio::process::Command::new(&bin);
        cmd.args(args);
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        cmd.env_clear();
        // Minimal env: PATH for the runtime, isolated state dir.
        if let Ok(path) = std::env::var("PATH") {
            cmd.env("PATH", path);
        }
        let state_dir = std::env::temp_dir().join(format!(
            "castor-mcp-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::create_dir_all(&state_dir);
        cmd.env("CASTOR_STATE_DIR", state_dir.to_str().unwrap());
        for (k, v) in extra_env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().expect("failed to spawn castor binary");
        let stdout = child.stdout.take().expect("no stdout");
        let stdin = child.stdin.take().expect("no stdin");
        (
            child,
            tokio::io::BufReader::new(stdout),
            stdin,
        )
    }

    async fn send_line(stdin: &mut tokio::process::ChildStdin, line: &str) {
        use tokio::io::AsyncWriteExt;
        stdin
            .write_all(format!("{line}\n").as_bytes())
            .await
            .expect("failed to write to stdin");
        stdin.flush().await.expect("failed to flush stdin");
    }

    async fn read_jsonrpc_line(
        reader: &mut tokio::io::BufReader<tokio::process::ChildStdout>,
    ) -> serde_json::Value {
        use tokio::io::AsyncBufReadExt;
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .await
            .expect("failed to read stdout line");
        let trimmed = line.trim();
        assert!(
            !trimmed.is_empty(),
            "stdout must not contain blank lines (JSON-RPC purity)"
        );
        let v: serde_json::Value = serde_json::from_str(trimmed)
            .unwrap_or_else(|e| panic!("stdout line is not valid JSON: {trimmed:?} ({e})"));
        assert!(
            v.get("jsonrpc").is_some(),
            "every stdout line must be a JSON-RPC object, got: {v}"
        );
        v
    }

    #[tokio::test]
    async fn stdio_purity_initialize_and_tools_list() {
        let (mut child, mut reader, mut stdin) =
            spawn_and_handshake(&[], &[]).await;

        // 1. initialize
        send_line(
            &mut stdin,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0.0.0"}}}"#,
        )
        .await;
        let init_resp = read_jsonrpc_line(&mut reader).await;
        assert_eq!(init_resp["id"], json!(1));
        assert!(
            init_resp.get("result").is_some(),
            "initialize must return a result, got: {init_resp}"
        );
        assert!(
            init_resp["result"]["capabilities"].get("tools").is_some(),
            "initialize result must advertise the tools capability, got: {}",
            init_resp["result"]["capabilities"]
        );

        // 2. notifications/initialized (no response expected)
        send_line(
            &mut stdin,
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        )
        .await;

        // 3. tools/list
        send_line(
            &mut stdin,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#,
        )
        .await;
        let list_resp = read_jsonrpc_line(&mut reader).await;
        assert_eq!(list_resp["id"], json!(2));
        let tools = list_resp["result"]["tools"]
            .as_array()
            .expect("tools/list result must contain a tools array");
        let names: Vec<&str> = tools
            .iter()
            .map(|t| t["name"].as_str().unwrap_or(""))
            .collect();
        let expected: Vec<String> = TOOL_BASE_NAMES
            .iter()
            .map(|b| format!("{DEFAULT_TOOL_PREFIX}_{b}"))
            .collect();
        assert_eq!(
            names,
            expected,
            "tools/list over stdio must match manifest constants"
        );

        // 4. tools/call → isError
        send_line(
            &mut stdin,
            &format!(
                r#"{{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{{"name":"{}","arguments":{{"prompt":"hello"}}}}}}"#,
                expected[0]
            ),
        )
        .await;
        let call_resp = read_jsonrpc_line(&mut reader).await;
        assert_eq!(call_resp["id"], json!(3));
        assert!(
            call_resp["result"]["isError"] == json!(true),
            "tools/call must return isError=true, got: {}",
            call_resp["result"]
        );
        let text = call_resp["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or("");
        assert!(
            text.contains(NOT_IMPLEMENTED_MSG),
            "tools/call text must contain '{NOT_IMPLEMENTED_MSG}', got: {text}"
        );

        // Close stdin → server should exit cleanly.
        drop(stdin);
        let status = child.wait().await.expect("failed to wait for child");
        assert!(
            status.success(),
            "castor must exit cleanly after stdin closes, got: {status}"
        );
    }

    #[tokio::test]
    async fn stdio_purity_tool_prefix_env_override() {
        let (mut child, mut reader, mut stdin) =
            spawn_and_handshake(&[], &[("CASTOR_TOOL_PREFIX", "acme")]).await;

        send_line(
            &mut stdin,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0.0.0"}}}"#,
        )
        .await;
        let _ = read_jsonrpc_line(&mut reader).await;
        send_line(
            &mut stdin,
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        )
        .await;
        send_line(
            &mut stdin,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#,
        )
        .await;
        let list_resp = read_jsonrpc_line(&mut reader).await;
        let names: Vec<&str> = list_resp["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap_or(""))
            .collect();
        assert_eq!(
            names,
            vec!["acme_coworker", "acme_task", "acme_server"],
            "CASTOR_TOOL_PREFIX must override the tool-name prefix"
        );

        drop(stdin);
        let _ = child.wait().await;
    }

    #[tokio::test]
    async fn default_subcommand_is_mcp_server() {
        // No subcommand → the binary must behave as the MCP server.
        let (mut child, mut reader, mut stdin) =
            spawn_and_handshake(&[], &[]).await;

        send_line(
            &mut stdin,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0.0.0"}}}"#,
        )
        .await;
        let init_resp = read_jsonrpc_line(&mut reader).await;
        assert_eq!(init_resp["id"], json!(1));
        assert!(
            init_resp.get("result").is_some(),
            "default subcommand must serve the MCP server, got: {init_resp}"
        );

        drop(stdin);
        let status = child.wait().await.expect("failed to wait for child");
        assert!(status.success());
    }
}
