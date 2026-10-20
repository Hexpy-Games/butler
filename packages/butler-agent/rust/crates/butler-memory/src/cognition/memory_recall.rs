//! Source-backed recall operation owner and bounded continuation state.
//!
//! Start at [`MemoryRecall`] (`service`): the `recall_memory` tool binds the
//! caller (`tool`), then one pinned read (`query`) either selects and ranks
//! candidates (`selection`), binds their original sources (`binding`) and
//! publishes the first page (`response`), or continues a cursor page
//! (`continuation`).

mod binding;
mod continuation;
mod cursor;
pub(crate) mod details;
mod envelope;
mod evidence;
mod judge;
mod metrics;
mod query;
mod response;
mod selection;
mod service;
#[cfg(test)]
mod tests;
mod tool;
mod validate;
mod vector;

pub use judge::{
    ConfiguredRecallJudge, RecallJudgeCandidate, RecallJudgeFuture, RecallJudgeModelFuture,
    RecallJudgeModelSource, RecallJudgePort, RecallJudgeResult, RecallJudgeUnavailable,
};
pub use metrics::{RecallMetric, RecallMetricSink};
pub use service::MemoryRecall;
pub use vector::{RecallVectorFuture, RecallVectorPort};

/// The host ports one recall reads time, dates and collation through.
#[derive(Clone, Copy)]
struct Clocks<'a> {
    now_millis: &'a dyn Fn() -> i64,
    /// Epoch milliseconds of a date string, NaN when unparsable.
    parse_date: &'a dyn Fn(&str) -> f64,
    compare_locale: &'a dyn Fn(&str, &str) -> std::cmp::Ordering,
}
