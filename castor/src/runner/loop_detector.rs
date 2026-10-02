//! Sliding-window action-hash loop detector.
//!
//! Hashes each executed action (tool name + args) and keeps a window of the
//! most recent hashes. When the same action repeats `threshold` consecutive
//! times, an advisory is injected once; if it persists, the session is flagged
//! as a loop and must stop.

use std::collections::{hash_map::DefaultHasher, VecDeque};
use std::hash::{Hash, Hasher};

/// Outcome of recording an action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoopState {
    /// No loop detected.
    Ok,
    /// A loop was detected; an advisory has been injected (once).
    Advisory,
    /// The loop persisted after the advisory; the session must stop.
    LoopDetected,
}

/// Sliding-window detector for repeated identical actions.
#[derive(Debug)]
pub struct LoopDetector {
    window: usize,
    threshold: usize,
    history: VecDeque<u64>,
    advisory_injected: bool,
}

impl LoopDetector {
    pub fn new(window: usize, threshold: usize) -> Self {
        let window = window.max(1);
        Self {
            window,
            threshold: threshold.max(1),
            history: VecDeque::with_capacity(window),
            advisory_injected: false,
        }
    }

    /// Record an executed action and report the loop state.
    pub fn record(&mut self, name: &str, args: &str) -> LoopState {
        let hash = hash_action(name, args);
        self.history.push_back(hash);
        if self.history.len() > self.window {
            self.history.pop_front();
        }
        let last = *self.history.back().expect("history is non-empty");
        let mut count = 0;
        for h in self.history.iter().rev() {
            if *h == last {
                count += 1;
            } else {
                break;
            }
        }
        if count >= self.threshold {
            if self.advisory_injected {
                LoopState::LoopDetected
            } else {
                self.advisory_injected = true;
                LoopState::Advisory
            }
        } else {
            LoopState::Ok
        }
    }
}

fn hash_action(name: &str, args: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    name.hash(&mut hasher);
    args.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinct_actions_never_loop() {
        let mut d = LoopDetector::new(6, 3);
        for i in 0..10 {
            assert_eq!(d.record("read", &format!("file_{i}")), LoopState::Ok);
        }
    }

    #[test]
    fn identical_actions_advisory_then_detected() {
        let mut d = LoopDetector::new(6, 3);
        assert_eq!(d.record("bash", "ls"), LoopState::Ok);
        assert_eq!(d.record("bash", "ls"), LoopState::Ok);
        assert_eq!(d.record("bash", "ls"), LoopState::Advisory);
        assert_eq!(d.record("bash", "ls"), LoopState::LoopDetected);
    }

    #[test]
    fn a_different_action_resets_the_streak() {
        let mut d = LoopDetector::new(6, 3);
        assert_eq!(d.record("bash", "ls"), LoopState::Ok); // streak=1
        assert_eq!(d.record("bash", "ls"), LoopState::Ok); // streak=2
        assert_eq!(d.record("read", "other"), LoopState::Ok); // reset, streak=1
        assert_eq!(d.record("bash", "ls"), LoopState::Ok); // streak=1
        assert_eq!(d.record("bash", "ls"), LoopState::Ok); // streak=2
        // First threshold hit after the reset → advisory (not a hard stop).
        assert_eq!(d.record("bash", "ls"), LoopState::Advisory);
    }

    #[test]
    fn advisory_latches_then_hard_stops() {
        let mut d = LoopDetector::new(6, 3);
        assert_eq!(d.record("bash", "ls"), LoopState::Ok);
        assert_eq!(d.record("bash", "ls"), LoopState::Ok);
        assert_eq!(d.record("bash", "ls"), LoopState::Advisory);
        // The advisory is injected once; the next repetition is a hard stop.
        assert_eq!(d.record("bash", "ls"), LoopState::LoopDetected);
    }
}
