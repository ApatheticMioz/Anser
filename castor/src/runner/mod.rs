//! Session runner: the multi-turn agent loop.
//!
//! - [`ToolExecutor`]: the async trait the runner depends on for tool execution.
//! - [`ChatEngine`]: the async trait the runner depends on for engine chat.
//! - [`run_session`]: build messages (tool schemas last, vLLM APC contract) →
//!   engine chat → execute tool calls → append results → continue until the
//!   model produces a final or the turn budget is exhausted.
//!
//! Budgets, cooperative landing, loop detection, and the JSONL event ledger
//! live here; the loop detector and event logger are split into submodules.

pub mod events;
pub mod loop_detector;

use async_trait::async_trait;
use thiserror::Error;

use crate::engine::{EngineClient, EngineError, Message, ToolSchema};

use events::EventLogger;
use loop_detector::{LoopDetector, LoopState};

/// Default turn budget (from the task record; extendable up to `MAX_ELASTIC_TURNS`).
pub const DEFAULT_TURNS_BUDGET: u32 = 80;

/// Turns before the end of the budget at which a landing notice is injected.
const LANDING_WINDOW: u32 = 5;

/// Sliding-window size for loop detection (action hashes).
const LOOP_WINDOW: usize = 6;

/// Consecutive identical actions that trip loop detection.
const LOOP_THRESHOLD: usize = 3;

/// The async trait the runner depends on for tool execution.
///
/// M7 implements real tools behind this trait; the runner depends only on it.
#[async_trait]
pub trait ToolExecutor: Send + Sync {
    /// Execute a tool by name with JSON arguments.
    async fn execute(&self, name: &str, args_json: &str) -> Result<ToolOutcome, ToolError>;
}

/// The result of a tool execution.
#[derive(Debug, Clone)]
pub struct ToolOutcome {
    pub text: String,
}

/// An error from a tool execution.
#[derive(Debug, Error)]
pub enum ToolError {
    #[error("tool '{name}' failed: {message}")]
    Execute {
        name: String,
        message: String,
    },
}

/// The async trait the runner depends on for engine chat.
///
/// [`EngineClient`] implements this; tests inject a scripted engine.
#[async_trait]
pub trait ChatEngine: Send + Sync {
    /// One chat turn: send messages + tool schemas, get a completion.
    async fn chat(
        &self,
        messages: &[Message],
        tools: &[ToolSchema],
        stream: bool,
    ) -> Result<crate::engine::Completion, EngineError>;
}

#[async_trait]
impl ChatEngine for EngineClient {
    async fn chat(
        &self,
        messages: &[Message],
        tools: &[ToolSchema],
        stream: bool,
    ) -> Result<crate::engine::Completion, EngineError> {
        EngineClient::chat(self, messages, tools, stream).await
    }
}

/// The result of a session run.
#[derive(Debug, Clone)]
pub struct SessionResult {
    pub final_text: String,
    pub turns: u32,
    /// The effective turn budget that was applied.
    pub budget: u32,
    /// `"completed"`, `"completed_budget_exhausted"`, or `"failed"`.
    pub status: String,
}

/// An error from the session runner.
#[derive(Debug, Error)]
pub enum RunnerError {
    #[error("engine error: {0}")]
    Engine(#[from] EngineError),
    #[error("loop detected: repeated identical action '{name}'")]
    LoopDetected { name: String },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

fn msg(role: &str, content: impl Into<String>) -> Message {
    Message {
        role: role.into(),
        content: content.into(),
        tool_calls: Vec::new(),
        tool_call_id: None,
    }
}

/// Run a multi-turn agent session.
///
/// Builds the message list (tool schemas last, for the vLLM APC contract),
/// calls the engine, executes any tool calls via the [`ToolExecutor`], appends
/// the results as tool messages, and continues until the model produces a
/// final or the turn budget is exhausted.
pub async fn run_session(
    engine: &dyn ChatEngine,
    executor: &dyn ToolExecutor,
    logger: &EventLogger,
    system_prompt: &str,
    user_prompt: &str,
    tools: &[ToolSchema],
    turns_budget: u32,
) -> Result<SessionResult, RunnerError> {
    let budget = if turns_budget == 0 {
        DEFAULT_TURNS_BUDGET
    } else {
        turns_budget
    };

    let mut messages = vec![msg("system", system_prompt), msg("user", user_prompt)];
    let mut loop_detector = LoopDetector::new(LOOP_WINDOW, LOOP_THRESHOLD);
    let mut turns: u32 = 0;
    let mut final_text = String::new();
    let mut final_produced = false;
    let mut tool_activity = false;
    let mut landing_injected = false;
    let mut status = "completed".to_string();

    while turns < budget {
        // Cooperative landing: in the last ~5 turns, inject a budget notice.
        let remaining = budget - turns;
        if remaining <= LANDING_WINDOW && !landing_injected {
            let notice = format!(
                "[Budget Notice] You have {remaining} turns left in your budget. Land now: \
                 synthesize your final deliverable, findings, and grounded conclusions. \
                 Do not start new tool calls."
            );
            messages.push(msg("user", notice));
            landing_injected = true;
        }

        turns += 1;

        // Build the request: messages first, tool schemas last (APC contract).
        let completion = engine.chat(&messages, tools, true).await?;

        // Record the dispatch event.
        logger
            .append(serde_json::json!({
                "type": "dispatch",
                "turn": turns,
                "finish_reason": completion.finish_reason,
                "content": completion.content,
                "tool_calls": completion
                    .tool_calls
                    .iter()
                    .map(|tc| serde_json::json!({
                        "id": tc.id,
                        "name": tc.name,
                        "arguments": tc.arguments,
                    }))
                    .collect::<Vec<_>>(),
            }))
            .map_err(RunnerError::Io)?;

        // Append the assistant message.
        messages.push(Message {
            role: "assistant".into(),
            content: completion.content.clone(),
            tool_calls: completion.tool_calls.clone(),
            tool_call_id: None,
        });

        if completion.tool_calls.is_empty() {
            // Final content.
            final_text = completion.content;
            final_produced = true;

            // Degenerate final: empty/whitespace after real tool activity.
            if final_text.trim().is_empty() && tool_activity {
                // One salvage retry asking for a proper summary.
                messages.push(msg(
                    "user",
                    "[Salvage] Your previous response was empty. Provide a proper summary of \
                     your findings and the work you have completed.",
                ));
                let salvage = engine.chat(&messages, &[], true).await?;
                logger
                    .append(serde_json::json!({
                        "type": "salvage",
                        "turn": turns,
                        "content": salvage.content,
                    }))
                    .map_err(RunnerError::Io)?;
                if !salvage.content.trim().is_empty() {
                    final_text = salvage.content;
                } else {
                    // Honest failure.
                    status = "failed".to_string();
                    final_text = "DegenerateFinalError: the model produced an empty final after \
                                  tool activity; the salvage retry also produced no content."
                        .to_string();
                }
            }

            break;
        }

        // Execute each tool call.
        for tc in &completion.tool_calls {
            let outcome = match executor.execute(&tc.name, &tc.arguments).await {
                Ok(o) => o,
                Err(e) => ToolOutcome {
                    text: format!("Error: {e}"),
                },
            };
            tool_activity = true;

            // Append the tool result as a tool message.
            messages.push(Message {
                role: "tool".into(),
                content: outcome.text.clone(),
                tool_call_id: Some(tc.id.clone()),
                tool_calls: Vec::new(),
            });

            // Record the tool_result event.
            logger
                .append(serde_json::json!({
                    "type": "tool_result",
                    "turn": turns,
                    "tool_call_id": tc.id,
                    "name": tc.name,
                    "is_error": outcome.text.starts_with("Error:"),
                }))
                .map_err(RunnerError::Io)?;

            // Loop detection.
            match loop_detector.record(&tc.name, &tc.arguments) {
                LoopState::Ok => {}
                LoopState::Advisory => {
                    let advisory = format!(
                        "[Loop Advisory] You have repeated the same action '{}' multiple times in a \
                         row. Change your approach or synthesize your findings.",
                        tc.name
                    );
                    messages.push(msg("user", advisory));
                }
                LoopState::LoopDetected => {
                    return Err(RunnerError::LoopDetected {
                        name: tc.name.clone(),
                    });
                }
            }
        }
    }

    // Budget exhausted.
    if !final_produced {
        // Best-effort synthesis: ask the model to land one more time (tools stripped).
        messages.push(msg(
            "user",
            "[Final] Your turn budget is exhausted. Synthesize your final deliverable, findings, \
             and grounded conclusions now.",
        ));
        let completion = engine.chat(&messages, &[], true).await?;
        logger
            .append(serde_json::json!({
                "type": "dispatch",
                "turn": turns + 1,
                "finish_reason": completion.finish_reason,
                "content": completion.content,
                "tool_calls": [],
            }))
            .map_err(RunnerError::Io)?;
        final_text = completion.content;
        status = "completed_budget_exhausted".to_string();
    } else if turns >= budget {
        // The model landed on the last turn (cooperative landing).
        status = "completed_budget_exhausted".to_string();
    }

    // Record the final event.
    logger
        .append(serde_json::json!({
            "type": "final",
            "turn": turns,
            "status": status,
            "final_text": final_text,
        }))
        .map_err(RunnerError::Io)?;

    Ok(SessionResult {
        final_text,
        turns,
        budget,
        status,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::{Completion, Metrics, ToolCall};
    use crate::state::StateDir;
    use std::collections::VecDeque;

    /// A recorder that captures engine calls (messages + tools) for assertions.
    #[derive(Default)]
    struct CallRecorder {
        calls: tokio::sync::Mutex<Vec<(Vec<Message>, Vec<ToolSchema>)>>,
    }

    /// A scripted engine that records calls via a shared recorder.
    struct RecordingEngine {
        responses: tokio::sync::Mutex<VecDeque<Completion>>,
        recorder: std::sync::Arc<CallRecorder>,
    }

    impl RecordingEngine {
        fn new(responses: Vec<Completion>, recorder: std::sync::Arc<CallRecorder>) -> Self {
            Self {
                responses: tokio::sync::Mutex::new(responses.into()),
                recorder,
            }
        }
    }

    #[async_trait]
    impl ChatEngine for RecordingEngine {
        async fn chat(
            &self,
            messages: &[Message],
            tools: &[ToolSchema],
            _stream: bool,
        ) -> Result<Completion, EngineError> {
            self.recorder
                .calls
                .lock()
                .await
                .push((messages.to_vec(), tools.to_vec()));
            self.responses
                .lock()
                .await
                .pop_front()
                .ok_or_else(|| EngineError::Malformed("no scripted response".into()))
        }
    }

    /// A mock executor that records calls and returns canned results.
    struct MockExecutor {
        results: tokio::sync::Mutex<VecDeque<String>>,
        calls: tokio::sync::Mutex<Vec<(String, String)>>,
    }

    impl MockExecutor {
        fn new(results: Vec<String>) -> Self {
            Self {
                results: tokio::sync::Mutex::new(results.into()),
                calls: tokio::sync::Mutex::new(Vec::new()),
            }
        }

        async fn calls(&self) -> Vec<(String, String)> {
            self.calls.lock().await.clone()
        }
    }

    #[async_trait]
    impl ToolExecutor for MockExecutor {
        async fn execute(&self, name: &str, args_json: &str) -> Result<ToolOutcome, ToolError> {
            self.calls
                .lock()
                .await
                .push((name.to_string(), args_json.to_string()));
            let text = self
                .results
                .lock()
                .await
                .pop_front()
                .ok_or_else(|| ToolError::Execute {
                    name: name.to_string(),
                    message: "no scripted result".into(),
                })?;
            Ok(ToolOutcome { text })
        }
    }

    fn comp(content: &str, tool_calls: Vec<ToolCall>) -> Completion {
        let finish = if tool_calls.is_empty() { "stop" } else { "tool_calls" };
        Completion {
            content: content.into(),
            tool_calls,
            finish_reason: Some(finish.into()),
            metrics: Metrics {
                ttft_ms: None,
                total_ms: 1.0,
                tokens_per_sec: None,
                completion_tokens: None,
            },
        }
    }

    fn tc(id: &str, name: &str, args: &str) -> ToolCall {
        ToolCall {
            index: 0,
            id: id.into(),
            name: name.into(),
            arguments: args.into(),
        }
    }

    fn tool_schema(name: &str) -> ToolSchema {
        ToolSchema {
            name: name.into(),
            description: format!("{name} tool"),
            parameters: serde_json::json!({"type": "object"}),
        }
    }

    fn tmp_state() -> StateDir {
        let dir = std::env::temp_dir().join(format!(
            "castor_runner_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let state = StateDir::new(&dir);
        let _ = state.ensure();
        state
    }

    fn logger_for(state: &StateDir) -> EventLogger {
        EventLogger::new(state, "test_session")
    }

    #[tokio::test]
    async fn happy_path_tool_then_final() {
        let state = tmp_state();
        let logger = logger_for(&state);
        let recorder = std::sync::Arc::new(CallRecorder::default());
        let engine = RecordingEngine::new(
            vec![
                comp("", vec![tc("c1", "bash", "{\"cmd\":\"ls\"}")]),
                comp("All done.", Vec::new()),
            ],
            recorder.clone(),
        );
        let executor = MockExecutor::new(vec!["file1\nfile2".into()]);

        let res = run_session(
            &engine,
            &executor,
            &logger,
            "sys",
            "do the thing",
            &[tool_schema("bash")],
            80,
        )
        .await
        .unwrap();

        assert_eq!(res.final_text, "All done.");
        assert_eq!(res.status, "completed");
        assert_eq!(res.turns, 2);
        assert_eq!(res.budget, 80);

        // The tool was executed.
        let calls = executor.calls().await;
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "bash");

        // The tool result was appended as a tool message (visible in the 2nd call).
        let second_call_msgs = &recorder.calls.lock().await[1].0;
        assert!(second_call_msgs
            .iter()
            .any(|m| m.role == "tool" && m.content == "file1\nfile2"));

        // The final event was recorded.
        let events = logger.read_all();
        assert!(events.iter().any(|e| e["type"] == "final" && e["status"] == "completed"));
    }

    #[tokio::test]
    async fn multi_turn_continuation() {
        let state = tmp_state();
        let logger = logger_for(&state);
        let recorder = std::sync::Arc::new(CallRecorder::default());
        let engine = RecordingEngine::new(
            vec![
                comp("", vec![tc("c1", "read", "{\"path\":\"a\"}")]),
                comp("", vec![tc("c2", "read", "{\"path\":\"b\"}")]),
                comp("Done.", Vec::new()),
            ],
            recorder.clone(),
        );
        let executor = MockExecutor::new(vec!["content-a".into(), "content-b".into()]);

        let res = run_session(
            &engine,
            &executor,
            &logger,
            "sys",
            "read two files",
            &[tool_schema("read")],
            80,
        )
        .await
        .unwrap();

        assert_eq!(res.final_text, "Done.");
        assert_eq!(res.status, "completed");
        assert_eq!(res.turns, 3);

        // Both tools were executed in order.
        let calls = executor.calls().await;
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].0, "read");
        assert_eq!(calls[1].0, "read");
    }

    #[tokio::test]
    async fn budget_exhaustion_landing_notice_and_best_effort_final() {
        let state = tmp_state();
        let logger = logger_for(&state);
        let recorder = std::sync::Arc::new(CallRecorder::default());
        // The model keeps calling tools; the budget (3) is exhausted.
        let engine = RecordingEngine::new(
            vec![
                comp("", vec![tc("c1", "bash", "1")]),
                comp("", vec![tc("c2", "bash", "2")]),
                comp("", vec![tc("c3", "bash", "3")]),
                comp("Best-effort final.", Vec::new()),
            ],
            recorder.clone(),
        );
        let executor = MockExecutor::new(vec!["r1".into(), "r2".into(), "r3".into()]);

        let res = run_session(
            &engine,
            &executor,
            &logger,
            "sys",
            "work",
            &[tool_schema("bash")],
            3,
        )
        .await
        .unwrap();

        assert_eq!(res.status, "completed_budget_exhausted");
        assert_eq!(res.final_text, "Best-effort final.");
        assert_eq!(res.budget, 3);

        // The landing notice was injected into a call's messages.
        let calls = recorder.calls.lock().await;
        let notice_injected = calls
            .iter()
            .any(|(msgs, _)| msgs.iter().any(|m| m.content.contains("[Budget Notice]")));
        assert!(notice_injected, "landing notice must be present in messages");

        // The best-effort synthesis call had no tools (stripped).
        let last_call = calls.last().unwrap();
        assert!(last_call.1.is_empty(), "final synthesis must strip tools");
    }

    #[tokio::test]
    async fn degenerate_final_triggers_salvage_retry() {
        let state = tmp_state();
        let logger = logger_for(&state);
        let recorder = std::sync::Arc::new(CallRecorder::default());
        // Tool call, then an empty final, then a salvage response.
        let engine = RecordingEngine::new(
            vec![
                comp("", vec![tc("c1", "bash", "x")]),
                comp("   ", Vec::new()),
                comp("Salvaged summary.", Vec::new()),
            ],
            recorder.clone(),
        );
        let executor = MockExecutor::new(vec!["ok".into()]);

        let res = run_session(
            &engine,
            &executor,
            &logger,
            "sys",
            "work",
            &[tool_schema("bash")],
            80,
        )
        .await
        .unwrap();

        assert_eq!(res.final_text, "Salvaged summary.");
        assert_eq!(res.status, "completed");

        // The salvage prompt was injected into a call's messages.
        let calls = recorder.calls.lock().await;
        let salvage_injected = calls
            .iter()
            .any(|(msgs, _)| msgs.iter().any(|m| m.content.contains("[Salvage]")));
        assert!(salvage_injected, "salvage prompt must be present in messages");
    }

    #[tokio::test]
    async fn repeated_identical_tool_call_trips_loop_detection() {
        let state = tmp_state();
        let logger = logger_for(&state);
        let recorder = std::sync::Arc::new(CallRecorder::default());
        // The model repeats the identical tool call 4 times.
        let engine = RecordingEngine::new(
            vec![
                comp("", vec![tc("c1", "bash", "same")]),
                comp("", vec![tc("c2", "bash", "same")]),
                comp("", vec![tc("c3", "bash", "same")]),
                comp("", vec![tc("c4", "bash", "same")]),
            ],
            recorder.clone(),
        );
        let executor = MockExecutor::new(vec!["r".into(), "r".into(), "r".into(), "r".into()]);

        let err = run_session(
            &engine,
            &executor,
            &logger,
            "sys",
            "work",
            &[tool_schema("bash")],
            80,
        )
        .await
        .unwrap_err();

        assert!(
            matches!(err, RunnerError::LoopDetected { .. }),
            "expected LoopDetected, got {err:?}"
        );

        // The advisory was injected into a call's messages.
        let calls = recorder.calls.lock().await;
        let advisory_injected = calls
            .iter()
            .any(|(msgs, _)| msgs.iter().any(|m| m.content.contains("[Loop Advisory]")));
        assert!(advisory_injected, "loop advisory must be present in messages");
    }

    #[tokio::test]
    async fn tool_error_becomes_a_message_and_loop_continues() {
        let state = tmp_state();
        let logger = logger_for(&state);
        let recorder = std::sync::Arc::new(CallRecorder::default());
        // A tool that errors, then a final.
        let engine = RecordingEngine::new(
            vec![
                comp("", vec![tc("c1", "bash", "boom")]),
                comp("Recovered.", Vec::new()),
            ],
            recorder.clone(),
        );
        // The executor returns an error for the first call.
        // We need the executor to return an error. Use a custom one.
        struct ErrExecutor {
            calls: tokio::sync::Mutex<Vec<(String, String)>>,
        }
        #[async_trait]
        impl ToolExecutor for ErrExecutor {
            async fn execute(&self, name: &str, args_json: &str) -> Result<ToolOutcome, ToolError> {
                self.calls
                    .lock()
                    .await
                    .push((name.to_string(), args_json.to_string()));
                Err(ToolError::Execute {
                    name: name.to_string(),
                    message: "boom failed".into(),
                })
            }
        }
        let err_exec = ErrExecutor {
            calls: tokio::sync::Mutex::new(Vec::new()),
        };

        let res = run_session(
            &engine,
            &err_exec,
            &logger,
            "sys",
            "work",
            &[tool_schema("bash")],
            80,
        )
        .await
        .unwrap();

        assert_eq!(res.final_text, "Recovered.");
        assert_eq!(res.status, "completed");

        // The tool error became a message (visible in the 2nd call).
        let calls = recorder.calls.lock().await;
        let second_call_msgs = &calls[1].0;
        assert!(second_call_msgs
            .iter()
            .any(|m| m.role == "tool" && m.content.contains("Error:")));
    }

    #[tokio::test]
    async fn tool_schemas_are_sent_last() {
        let state = tmp_state();
        let logger = logger_for(&state);
        let recorder = std::sync::Arc::new(CallRecorder::default());
        let engine = RecordingEngine::new(vec![comp("Done.", Vec::new())], recorder.clone());
        let executor = MockExecutor::new(Vec::new());

        let tools = vec![tool_schema("bash"), tool_schema("read")];
        let res = run_session(
            &engine,
            &executor,
            &logger,
            "sys",
            "work",
            &tools,
            80,
        )
        .await
        .unwrap();

        assert_eq!(res.final_text, "Done.");
        assert_eq!(res.status, "completed");

        // The tools were sent in the request.
        let calls = recorder.calls.lock().await;
        let first_call_tools = &calls[0].1;
        assert_eq!(first_call_tools.len(), 2);
        assert_eq!(first_call_tools[0].name, "bash");
        assert_eq!(first_call_tools[1].name, "read");
    }
}
