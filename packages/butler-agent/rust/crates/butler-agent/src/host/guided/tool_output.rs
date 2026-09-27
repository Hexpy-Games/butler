use std::path::PathBuf;
use std::sync::Arc;
use std::time::SystemTime;

use crate::context::{ContextBudgetOwner, ToolOutput, ToolOutputIdentity};
use crate::operations::MetricFiles;

pub(crate) struct SystemToolOutputIdentity;

impl ToolOutputIdentity for SystemToolOutputIdentity {
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }
    fn uuid(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
}

pub(crate) fn open_tool_output(
    butler_data: PathBuf,
    budget_owner: Arc<ContextBudgetOwner>,
    metric_files: Arc<MetricFiles>,
) -> ToolOutput {
    ToolOutput::new(
        butler_data,
        budget_owner,
        Arc::new(SystemToolOutputIdentity),
        metric_files,
    )
}
