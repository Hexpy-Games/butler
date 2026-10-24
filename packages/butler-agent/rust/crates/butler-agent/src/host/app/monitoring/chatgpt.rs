//! Account projection refreshed only when the credential owner changes revision.
use butler_models::models::{ModelConfiguration, chatgpt};
use std::sync::Arc;
use tokio::sync::Mutex;
#[derive(Default)]
pub(super) struct Account(Mutex<Option<(u64, Option<String>)>>);
impl Account {
    pub(super) async fn current(&self, config: &Arc<ModelConfiguration>) -> Option<String> {
        let revision = *config.chatgpt_revision().borrow();
        let mut cached = self.0.lock().await;
        if let Some((seen, account)) = &*cached
            && *seen == revision
        {
            return account.clone();
        }
        let account = match config.chatgpt_paths().await {
            Ok(paths) => chatgpt::store::read(&paths.registration)
                .await
                .ok()
                .and_then(|raw| {
                    (chatgpt::signed_in(&raw) && raw["sign_in_required"].is_null())
                        .then(|| chatgpt::registration(&raw))
                        .flatten()
                }),
            Err(_) => None,
        };
        *cached = Some((revision, account.clone()));
        account
    }
}
