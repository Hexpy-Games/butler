//! Primary native Turn prompt assembly and its explicit domain collaborators.

mod assembler;
mod cache;
mod files;
mod project_instructions;
mod runtime;
mod schedule;
mod sections;
#[cfg(test)]
mod tests;
mod types;

pub use assembler::PromptAssembler;
pub use types::*;

use crate::context::ContextResult;

pub trait PromptClock: Send + Sync {
    /// The host timezone, read per turn so a changed system zone applies.
    fn default_timezone(&self) -> String;
    fn local_timestamp(&self, value: i64, _timezone: &str) -> ContextResult<String> {
        self.iso_from_epoch_millis(value)
    }
    fn now_epoch_millis(&self) -> i64;
    fn parse_timestamp(&self, value: &str) -> Option<i64>;
    fn iso_from_epoch_millis(&self, value: i64) -> ContextResult<String>;
    fn format_local_time(&self, value: i64, timezone: &str) -> ContextResult<String>;
}
