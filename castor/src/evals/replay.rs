//! Trace replayer: a [`ChatEngine`] that replays a recorded session trace.
//!
//! The engine returns the next recorded model response on each `chat` call,
//! in order. When the trace is exhausted it returns a typed
//! [`EngineError::TraceExhausted`] — the runner sees a clean engine failure,
//! never improvised content.

use std::collections::VecDeque;

use async_trait::async_trait;

use crate::engine::{Completion, EngineError, Message, Metrics, ToolCall, ToolSchema};
use crate::evals::fixture::TraceStep;
use crate::runner::ChatEngine;

/// A [`ChatEngine`] that replays a recorded trace.
///
/// Only the model's responses (`AssistantMessage` steps) are replayed;
/// harness/tool events (`SessionStart`, `ToolCall`, `ToolResult`,
/// `ToolOutputSpilled`, `SessionEnd`) are skipped, since the runner
/// regenerates tool activity by executing the tool calls it receives.
pub struct ReplayEngine {
    responses: std::sync::Mutex<VecDeque<Completion>>,
}

impl ReplayEngine {
    /// Build a replay engine from a recorded trace.
    ///
    /// Each `AssistantMessage` step is converted to a [`Completion`] with its
    /// tool calls passed through unchanged (id, name, arguments). The
    /// `finish_reason` is `"tool_calls"` when the response carries tool calls,
    /// otherwise `"stop"`.
    pub fn new(steps: Vec<TraceStep>) -> Self {
        let responses = steps
            .into_iter()
            .filter_map(|step| match step {
                TraceStep::AssistantMessage {
                    content,
                    tool_calls,
                    ..
                } => {
                    let tool_calls: Vec<ToolCall> = tool_calls
                        .into_iter()
                        .enumerate()
                        .map(|(index, ref_)| ToolCall {
                            index,
                            id: ref_.id,
                            name: ref_.function.name,
                            arguments: ref_.function.arguments,
                        })
                        .collect();
                    let finish_reason = if tool_calls.is_empty() {
                        "stop"
                    } else {
                        "tool_calls"
                    };
                    Some(Completion {
                        content,
                        tool_calls,
                        finish_reason: Some(finish_reason.into()),
                        metrics: Metrics {
                            ttft_ms: None,
                            total_ms: 0.0,
                            tokens_per_sec: None,
                            completion_tokens: None,
                        },
                    })
                }
                _ => None,
            })
            .collect();
        Self {
            responses: std::sync::Mutex::new(responses),
        }
    }
}

#[async_trait]
impl ChatEngine for ReplayEngine {
    async fn chat(
        &self,
        _messages: &[Message],
        _tools: &[ToolSchema],
        _stream: bool,
    ) -> Result<Completion, EngineError> {
        // The critical section is synchronous (no await while locked), so a
        // std Mutex is sufficient and cheaper than a tokio Mutex.
        self.responses
            .lock()
            .expect("replay engine responses mutex poisoned")
            .pop_front()
            .ok_or(EngineError::TraceExhausted)
    }
}

#[cfg(test)]
mod tests {
    use super::ReplayEngine;
    use crate::engine::EngineError;
    use crate::evals::fixture::{ToolCallFunction, ToolCallRef, TraceStep};
    use crate::runner::ChatEngine;

    fn assistant(content: &str, tool_calls: Vec<ToolCallRef>) -> TraceStep {
        TraceStep::AssistantMessage {
            timestamp: "t".into(),
            session_id: "s".into(),
            content: content.into(),
            tool_calls,
        }
    }

    fn tool_call_ref(id: &str, name: &str, arguments: &str) -> ToolCallRef {
        ToolCallRef {
            id: id.into(),
            r#type: "function".into(),
            function: ToolCallFunction {
                name: name.into(),
                arguments: arguments.into(),
            },
        }
    }

    #[tokio::test]
    async fn replays_recorded_responses_in_order() {
        let steps = vec![
            assistant("one", Vec::new()),
            assistant("two", Vec::new()),
            assistant("three", Vec::new()),
        ];
        let engine = ReplayEngine::new(steps);

        let r1 = engine.chat(&[], &[], true).await.unwrap();
        assert_eq!(r1.content, "one");
        let r2 = engine.chat(&[], &[], true).await.unwrap();
        assert_eq!(r2.content, "two");
        let r3 = engine.chat(&[], &[], true).await.unwrap();
        assert_eq!(r3.content, "three");

        // Fourth call: the trace is exhausted.
        let err = engine.chat(&[], &[], true).await.unwrap_err();
        assert!(matches!(err, EngineError::TraceExhausted), "{err:?}");
    }

    #[tokio::test]
    async fn empty_trace_errors_on_first_call() {
        let engine = ReplayEngine::new(Vec::new());
        let err = engine.chat(&[], &[], true).await.unwrap_err();
        assert!(matches!(err, EngineError::TraceExhausted), "{err:?}");
    }

    #[tokio::test]
    async fn tool_calls_pass_through_unchanged() {
        let steps = vec![assistant(
            "calling a tool",
            vec![
                tool_call_ref("call_1", "bash", "{\"cmd\":\"ls\"}"),
                tool_call_ref("call_2", "read", "{\"path\":\"/tmp\"}"),
            ],
        )];
        let engine = ReplayEngine::new(steps);

        let r = engine.chat(&[], &[], true).await.unwrap();
        assert_eq!(r.content, "calling a tool");
        assert_eq!(r.finish_reason.as_deref(), Some("tool_calls"));
        assert_eq!(r.tool_calls.len(), 2);
        assert_eq!(r.tool_calls[0].id, "call_1");
        assert_eq!(r.tool_calls[0].name, "bash");
        assert_eq!(r.tool_calls[0].arguments, "{\"cmd\":\"ls\"}");
        assert_eq!(r.tool_calls[1].id, "call_2");
        assert_eq!(r.tool_calls[1].name, "read");
        assert_eq!(r.tool_calls[1].arguments, "{\"path\":\"/tmp\"}");
    }
}
