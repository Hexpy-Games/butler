//! Where the reader's render step (web_read, #171) runs. The gateway
//! registers a port that follows the browser order: the attached App, the
//! hidden App host, then Butler's headless browser. Without a port (no
//! gateway in this process) the headless browser renders directly.
use super::headless::{Rendered, reader as headless_reader};
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

/// One render: `None` when no browser serves renders, else its outcome.
pub type RenderFuture =
    Pin<Box<dyn Future<Output = Option<Result<Rendered, &'static str>>> + Send>>;

pub trait RenderPort: Send + Sync {
    fn render(&self, url: String, wait: Duration) -> RenderFuture;

    /// An Electron browser host is attached; checking never starts a host.
    fn host_attached(&self) -> bool;
}

static PORT: Mutex<Option<Arc<dyn RenderPort>>> = Mutex::new(None);

/// Uses the same live host state as browser dispatch, without polling or I/O.
pub fn host_attached() -> bool {
    PORT.lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
        .is_some_and(|port| port.host_attached())
}

/// Registers the port renders go through from now on.
pub fn set_render_port(port: Arc<dyn RenderPort>) {
    *PORT.lock().unwrap_or_else(PoisonError::into_inner) = Some(port);
}

/// Renders `url` for the reader; `None` when no browser serves renders.
pub async fn render(url: &str, wait: Duration) -> Option<Result<Rendered, &'static str>> {
    let port = PORT.lock().unwrap_or_else(PoisonError::into_inner).clone();
    match port {
        Some(port) => port.render(url.to_owned(), wait).await,
        None => Some(headless_reader()?.render(url, wait).await),
    }
}
