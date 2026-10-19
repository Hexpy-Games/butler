//! App session title generation contract.
use super::ApplicationFuture;

#[derive(Clone, Debug)]
pub struct AppSessionTitleInput {
    pub usage_session_id: Option<String>,
    pub text: String,
    pub model_ref: String,
}

pub trait AppSessionTitleGenerator: Send + Sync + 'static {
    fn generate(
        &self,
        input: AppSessionTitleInput,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> ApplicationFuture<String>;
}
