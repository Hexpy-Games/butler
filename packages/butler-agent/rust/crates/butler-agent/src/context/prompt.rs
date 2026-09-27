//! Primary native Turn prompt assembly and its explicit domain collaborators.

mod assembler;
mod cache;
mod files;
mod runtime;
mod sections;
#[cfg(test)]
mod tests;
mod types;

pub(crate) use assembler::PromptAssembler;
pub(crate) use types::*;

use crate::context::ContextResult;

pub(crate) trait PromptClock: Send + Sync {
    fn now_epoch_millis(&self) -> i64;
    fn parse_timestamp(&self, value: &str) -> Option<i64>;
    fn iso_from_epoch_millis(&self, value: i64) -> ContextResult<String>;
    fn format_local_time(&self, value: i64, timezone: &str) -> ContextResult<String>;
}
