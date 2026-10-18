//! Short-lived CLI processes initialize a writer only when they actually send HTTP.
use std::{future::Future, io, pin::Pin, sync::OnceLock};
type Open =
    dyn Fn() -> Pin<Box<dyn Future<Output = io::Result<crate::Logger>> + Send>> + Send + Sync;
static OPEN: OnceLock<Box<Open>> = OnceLock::new();
static STARTED: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();

/// The host supplies validated data/configuration without opening files for help commands.
pub fn initialize_with<F, Fut>(open: F) -> io::Result<()>
where
    F: Fn() -> Fut + Send + Sync + 'static,
    Fut: Future<Output = io::Result<crate::Logger>> + Send + 'static,
{
    OPEN.set(Box::new(move || Box::pin(open())))
        .map_err(|_| io::Error::other("HTTP logger initializer already installed"))
}
pub(super) async fn ensure() {
    if crate::global().is_some() {
        return;
    }
    if let Some(open) = OPEN.get() {
        STARTED
            .get_or_init(|| async {
                if open().await.and_then(crate::install).is_err() {
                    eprintln!("http_logging_unavailable: continuing without HTTP logs");
                }
            })
            .await;
    }
}
/// Bound the exit wait for the writer this boundary started. Service-owned
/// writers retain their durable shutdown; no blocking task can outlive this wait.
pub async fn shutdown() -> io::Result<()> {
    if STARTED.get().is_some()
        && let Some(log) = crate::global().cloned()
    {
        log.shutdown_bounded(std::time::Duration::from_millis(250))
            .await?;
    }
    Ok(())
}
