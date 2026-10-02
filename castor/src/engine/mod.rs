//! Engine orchestration: OpenAI-compatible chat client and lifecycle.

pub mod lifecycle;
pub mod provider;

pub use lifecycle::{EngineLifecycle, LifecycleError};
pub use provider::{Completion, EngineClient, EngineError, Message, Metrics, ToolCall};
