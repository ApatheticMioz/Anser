//! Evals data model: strict typed parsing of the eval fixture formats
//! defined in `castor/evals/EVALS.md` (`task.toml` + `trace.jsonl`).
//!
//! Data model only — no harness, runner, or scorer logic in this module.

pub mod fixture;
pub mod replay;

pub use fixture::{
    Check, Scorer, Task, TaskConfig, TaskError, ToolCallFunction, ToolCallRef, Trace, TraceError,
    TraceStep,
};
pub use replay::ReplayEngine;
