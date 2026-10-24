//! Public account projections contain no credentials or internal account IDs.
use butler_gateway::gateway::{
    ApplicationFuture, ChatGptNoticeInput, ChatGptNoticeKind, ChatGptSignOutView,
    GatewayApplicationError,
};
use butler_models::models::{ModelConfiguration, chatgpt::ChatGptAccountState};
use std::sync::Arc;

pub(super) fn view(
    configuration: Arc<ModelConfiguration>,
) -> ApplicationFuture<ChatGptAccountState> {
    Box::pin(async move { configuration.chatgpt_account().await.map_err(error) })
}
pub(super) fn notice(
    configuration: Arc<ModelConfiguration>,
    input: ChatGptNoticeInput,
) -> ApplicationFuture<ChatGptAccountState> {
    Box::pin(async move {
        configuration
            .chatgpt_acknowledge(matches!(input.kind, ChatGptNoticeKind::Legacy))
            .await
            .map_err(error)
    })
}
pub(super) fn sign_out(
    configuration: Arc<ModelConfiguration>,
) -> ApplicationFuture<ChatGptSignOutView> {
    Box::pin(async move {
        let revoked = configuration.chatgpt_sign_out().await.map_err(error)?;
        let account = configuration.chatgpt_account().await.map_err(error)?;
        Ok(ChatGptSignOutView { revoked, account })
    })
}
fn error(code: &'static str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 500,
        code: code.into(),
        message: "ChatGPT account could not be updated.".into(),
        source: None,
    }
}
