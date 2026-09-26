use std::path::PathBuf;
use std::sync::Arc;
use std::time::SystemTime;

use crate::context::{ContextBudgetOwner, NativeToolOutput, ToolOutputIdentity};
use crate::operations::MetricFiles;

pub(crate) struct NativeToolOutputIdentity;

impl ToolOutputIdentity for NativeToolOutputIdentity {
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }
    fn uuid(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
}

pub(crate) fn native_tool_output(
    butler_data: PathBuf,
    budget_owner: Arc<ContextBudgetOwner>,
    metric_files: Arc<MetricFiles>,
) -> NativeToolOutput {
    NativeToolOutput::new(
        butler_data,
        budget_owner,
        Arc::new(NativeToolOutputIdentity),
        metric_files,
    )
}
