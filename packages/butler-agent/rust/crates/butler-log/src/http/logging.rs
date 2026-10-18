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
pub(super) async fn ensure() -> io::Result<()> {
    if crate::global().is_some() {
        return Ok(());
    }
    if let Some(open) = OPEN.get() {
        STARTED
            .get_or_try_init(|| async { crate::install(open().await?) })
            .await?;
    }
    Ok(())
}
/// Flush only the writer this boundary started; service-owned writers close themselves.
pub async fn shutdown() -> io::Result<()> {
    if STARTED.get().is_some()
        && let Some(log) = crate::global().cloned()
    {
        tokio::task::spawn_blocking(move || log.shutdown())
            .await
            .map_err(io::Error::other)??;
    }
    Ok(())
}
