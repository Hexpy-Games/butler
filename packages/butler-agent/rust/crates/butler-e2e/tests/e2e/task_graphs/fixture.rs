//! Real Work/Subsession service fixture, shared with App smoke tests.
use butler_e2e::e2e::{HarnessError, harness_error, task_graph::GraphBuilder};
use std::path::Path;

pub(super) async fn seed(
    data: &Path,
    parent: &str,
    graphs: usize,
) -> Result<Vec<String>, HarnessError> {
    let mut builder = GraphBuilder::open(data).await.map_err(error)?;
    let ids = builder
        .seed(parent, &vec!["failed".to_owned(); graphs], 5)
        .await
        .map_err(error)?;
    builder.close().await.map_err(error)?;
    Ok(ids)
}
pub(super) fn error(error: impl std::fmt::Display) -> HarnessError {
    harness_error(error.to_string())
}
