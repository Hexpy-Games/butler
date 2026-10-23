//! App smart-group classification contract.
use super::ApplicationFuture;

#[derive(Clone, Debug)]
pub struct AppSessionTopicInput {
    pub usage_session_id: Option<String>,
    /// The JSON classification request sent as the user message.
    pub request_json: String,
    pub model_ref: String,
}

/// One tool-free round with [`super::SMART_GROUP_INSTRUCTIONS`]; returns the
/// model's raw reply text.
pub trait AppSessionTopicClassifier: Send + Sync + 'static {
    fn classify(
        &self,
        input: AppSessionTopicInput,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> ApplicationFuture<String>;
}
