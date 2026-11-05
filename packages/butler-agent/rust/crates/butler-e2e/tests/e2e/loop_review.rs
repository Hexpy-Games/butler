//! Agent-loop regressions against a scripted local model, stub tier.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
#[path = "loop_review/blocks_only_answer.rs"]
mod blocks_only_answer;
#[path = "loop_review/common.rs"]
mod common;
#[path = "loop_review/failed_command_result.rs"]
mod failed_command_result;
#[path = "loop_review/tool_feedback_order.rs"]
mod tool_feedback_order;
