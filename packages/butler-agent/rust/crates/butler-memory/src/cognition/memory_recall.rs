//! Source-backed recall operation owner and bounded continuation state.

mod binding;
mod continuation;
mod cursor;
mod envelope;
mod evidence;
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

pub use metrics::{RecallMetric, RecallMetricSink};
pub use service::MemoryRecall;
pub use vector::{RecallVectorFuture, RecallVectorPort};
