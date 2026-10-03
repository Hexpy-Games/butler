//! Read the user's memory-model selection for each explicit recall.
use butler_memory::cognition::{
    RecallJudgeModelFuture, RecallJudgeModelSource, RecallJudgeUnavailable,
};
use butler_models::models::ModelConfiguration;
use std::{path::PathBuf, sync::Arc};

pub(crate) struct RecallJudge {
    configuration: Arc<ModelConfiguration>,
    app_path: PathBuf,
}

impl RecallJudge {
    pub(crate) fn new(configuration: Arc<ModelConfiguration>, data_root: &std::path::Path) -> Self {
        let app_path =
            crate::host::service::configuration::AppServiceConfiguration::capture(data_root)
                .db_path;
        Self {
            configuration,
            app_path,
        }
    }

    async fn selection(&self) -> Result<Option<String>, RecallJudgeUnavailable> {
        let path = self.app_path.clone();
        let settings = tokio::task::spawn_blocking(move || {
            butler_gateway::gateway::read_new_chat_briefing_settings(&path)
        })
        .await
        .map_err(|_| RecallJudgeUnavailable)?;
        if settings
            .get("recall_mode")
            .and_then(serde_json::Value::as_str)
            == Some("faster")
        {
            return Ok(None);
        }
        let read = self
            .configuration
            .read()
            .await
            .map_err(|_| RecallJudgeUnavailable)?;
        let override_model = settings
            .get("recall_judge_model")
            .and_then(serde_json::Value::as_str)
            .filter(|value| *value != "default");
        let selected = override_model
            .or_else(|| {
                super::briefing::model_preference(&read.config, Some(&settings))
                    .and_then(serde_json::Value::as_str)
            })
            .ok_or(RecallJudgeUnavailable)?;
        let metadata = read
            .catalog
            .find_model_metadata(Some(selected))
            .ok_or(RecallJudgeUnavailable)?;
        if !metadata.runtime_supported
            || metadata.enabled == Some(false)
            || metadata.registered == Some(false)
        {
            return Err(RecallJudgeUnavailable);
        }
        Ok(Some(metadata.model_ref))
    }
}

impl RecallJudgeModelSource for RecallJudge {
    fn model(&self) -> RecallJudgeModelFuture<'_> {
        Box::pin(self.selection())
    }
}
