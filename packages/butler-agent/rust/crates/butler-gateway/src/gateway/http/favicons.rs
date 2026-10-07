//! Authenticated same-origin favicon assets. Work happens only on a cache miss.
mod disk;
mod fetch;
mod policy;

use super::{HttpError, HttpState, query};
use axum::{
    body::Body,
    http::{HeaderValue, StatusCode, Uri, header},
    response::Response,
};
use indexmap::IndexMap;
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Semaphore, watch};

#[derive(Clone)]
struct Icon {
    bytes: Vec<u8>,
    mime: &'static str,
    ext: &'static str,
}
impl Icon {
    fn new(bytes: Vec<u8>) -> Option<Self> {
        if bytes.is_empty() || bytes.len() > fetch::ICON_LIMIT {
            return None;
        }
        let (mime, ext) = policy::raster(&bytes)?;
        Some(Self { bytes, mime, ext })
    }
}

enum Entry {
    Ready {
        icon: Option<Icon>,
        fetched: Instant,
    },
    Pending(watch::Receiver<Option<Option<Icon>>>),
}

pub(super) struct Favicons {
    root: Option<PathBuf>,
    cache: Mutex<IndexMap<String, Entry>>,
    outbound: Semaphore,
    writes: Arc<Mutex<()>>,
}
impl Favicons {
    pub(super) fn new(root: Option<PathBuf>) -> Self {
        Self {
            root,
            cache: Mutex::new(IndexMap::new()),
            outbound: Semaphore::new(4),
            writes: Arc::new(Mutex::new(())),
        }
    }

    async fn lookup(self: &Arc<Self>, host: &str) -> Option<watch::Receiver<Option<Option<Icon>>>> {
        let mut cache = self.cache.lock().await;
        if let Some(entry) = cache.shift_remove(host) {
            match entry {
                Entry::Pending(receiver) => {
                    cache.insert(host.to_owned(), Entry::Pending(receiver.clone()));
                    return Some(receiver);
                }
                Entry::Ready { icon, fetched }
                    if icon.is_some() || fetched.elapsed() < Duration::from_secs(3600) =>
                {
                    let (_, receiver) = watch::channel(Some(icon.clone()));
                    cache.insert(host.to_owned(), Entry::Ready { icon, fetched });
                    return Some(receiver);
                }
                Entry::Ready { .. } => {}
            }
        }
        if cache.len() == 256 {
            let oldest = cache
                .iter()
                .position(|(_, entry)| matches!(entry, Entry::Ready { .. }))?;
            cache.shift_remove_index(oldest);
        }
        let (sender, receiver) = watch::channel(None);
        cache.insert(host.to_owned(), Entry::Pending(receiver.clone()));
        let service = Arc::clone(self);
        let host = host.to_owned();
        tokio::spawn(async move { service.populate(host, sender).await });
        Some(receiver)
    }

    async fn icon(self: &Arc<Self>, host: &str) -> Option<Icon> {
        if !policy::valid_host(host) {
            return None;
        }
        let mut receiver = self.lookup(host).await?;
        tokio::time::timeout(Duration::from_millis(3500), async {
            loop {
                if let Some(icon) = receiver.borrow_and_update().clone() {
                    return icon;
                }
                if receiver.changed().await.is_err() {
                    return None;
                }
            }
        })
        .await
        .ok()
        .flatten()
    }

    async fn populate(self: Arc<Self>, host: String, sender: watch::Sender<Option<Option<Icon>>>) {
        let icon = tokio::time::timeout(Duration::from_millis(3500), self.load(&host))
            .await
            .ok()
            .flatten();
        let mut cache = self.cache.lock().await;
        cache.shift_remove(&host);
        cache.insert(
            host,
            Entry::Ready {
                icon: icon.clone(),
                fetched: Instant::now(),
            },
        );
        let _ = sender.send(Some(icon));
    }

    async fn load(&self, host: &str) -> Option<Icon> {
        if let Some(root) = self.root.clone() {
            let host = host.to_owned();
            if let Some(icon) = tokio::task::spawn_blocking(move || disk::load(&root, &host))
                .await
                .ok()
                .flatten()
            {
                return Some(icon);
            }
        }
        let _permit = self.outbound.acquire().await.ok()?;
        let icon = fetch::fetch(host).await?;
        if let Some(root) = self.root.clone() {
            let write = Arc::clone(&self.writes).lock_owned().await;
            let host = host.to_owned();
            let copy = icon.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let _write = write;
                disk::store(&root, &host, &copy)
            })
            .await;
        }
        Some(icon)
    }
}

pub(super) async fn get(state: Arc<HttpState>, uri: &Uri) -> Result<Response, HttpError> {
    let params = query(uri);
    let host = params.get("host").map_or("", String::as_str);
    let icon = state.favicons.icon(host).await;
    let mut response = Response::new(
        icon.as_ref()
            .map_or_else(Body::empty, |icon| Body::from(icon.bytes.clone())),
    );
    if let Some(icon) = icon {
        response
            .headers_mut()
            .insert(header::CONTENT_TYPE, HeaderValue::from_static(icon.mime));
    } else {
        *response.status_mut() = StatusCode::NOT_FOUND;
    }
    for (name, value) in [
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; sandbox",
        ),
        (header::CACHE_CONTROL, "private, no-store"),
    ] {
        response
            .headers_mut()
            .insert(name, HeaderValue::from_static(value));
    }
    Ok(response)
}
