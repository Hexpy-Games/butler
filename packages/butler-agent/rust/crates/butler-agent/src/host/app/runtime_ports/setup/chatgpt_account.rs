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
pub(super) fn credentials(
    configuration: Arc<ModelConfiguration>,
) -> ApplicationFuture<butler_models::models::chatgpt::credentials::OauthCredentials> {
    Box::pin(async move { configuration.oauth_credentials().await.map_err(error) })
}
pub(super) fn remove_credential(
    configuration: Arc<ModelConfiguration>,
    id: String,
) -> ApplicationFuture<butler_models::models::chatgpt::credentials::RemovedOauthCredential> {
    Box::pin(async move {
        configuration
            .remove_oauth_credential(&id)
            .await
            .map_err(error)
    })
}
fn error(code: &'static str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: if code == "credential_not_found" {
            404
        } else {
            500
        },
        code: code.into(),
        message: "ChatGPT account could not be updated.".into(),
        source: None,
    }
}
