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

pub(crate) use metrics::{RecallMetric, RecallMetricSink};
pub(crate) use service::NativeMemoryRecall;
pub(crate) use vector::{NativeRecallVectorPort, RecallVectorFuture};
