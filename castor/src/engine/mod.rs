//! Engine orchestration: OpenAI-compatible chat client.

pub mod provider;

pub use provider::{Completion, EngineClient, EngineError, Message, Metrics, ToolCall};
