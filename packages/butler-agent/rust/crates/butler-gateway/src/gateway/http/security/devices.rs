//! Loaded once, write-through credentials; no background polling or timers.
use super::super::HttpError;
use crate::gateway::{
    GatewayApplication, PairedDevice,
    crypto::{constant_time_eq, random_bytes},
};
use axum::http::{HeaderMap, HeaderValue, header};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use parking_lot::RwLock;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio_util::sync::CancellationToken;

struct Entry {
    device: PairedDevice,
    seen: AtomicU64,
    persisted: AtomicU64,
    closed: CancellationToken,
}

pub(in crate::gateway::http) struct DeviceRegistry {
    application: Arc<dyn GatewayApplication>,
    entries: RwLock<Arc<HashMap<String, Arc<Entry>>>>,
    changes: tokio::sync::Mutex<()>,
    shutdown: CancellationToken,
    cookie_name: String,
    #[cfg(debug_assertions)]
    clock_offset: AtomicU64,
}

impl DeviceRegistry {
    pub(in crate::gateway::http) async fn load(
        application: Arc<dyn GatewayApplication>,
        port: u16,
        shutdown: CancellationToken,
    ) -> Result<Self, HttpError> {
        let entries = application
            .load_devices()
            .await?
            .into_iter()
            .map(|device| {
                let entry = Arc::new(Entry {
                    seen: AtomicU64::new(device.last_seen_at),
                    persisted: AtomicU64::new(device.last_seen_at),
                    closed: shutdown.child_token(),
                    device,
                });
                (entry.device.id.clone(), entry)
            })
            .collect();
        Ok(Self {
            application,
            entries: RwLock::new(Arc::new(entries)),
            changes: tokio::sync::Mutex::new(()),
            shutdown,
            cookie_name: format!("butler_session_{port}"),
            #[cfg(debug_assertions)]
            clock_offset: AtomicU64::new(0),
        })
    }

    fn now(&self) -> u64 {
        let now = super::unix_seconds(std::time::SystemTime::now());
        #[cfg(debug_assertions)]
        let now = now.saturating_add(self.clock_offset.load(Ordering::Relaxed));
        now
    }

    #[cfg(debug_assertions)]
    pub(in crate::gateway::http) fn advance(&self, seconds: u64) {
        self.clock_offset.fetch_add(seconds, Ordering::Relaxed);
    }

    pub(in crate::gateway::http) async fn pair(
        &self,
        name: &str,
        ip: &str,
    ) -> Result<(HeaderValue, String), HttpError> {
        let _change = self.changes.lock().await;
        let now = self.now();
        let secret = URL_SAFE_NO_PAD.encode(random_bytes());
        let id = uuid::Uuid::new_v4().to_string();
        let device = PairedDevice {
            id: id.clone(),
            secret_hash: Sha256::digest(secret.as_bytes()).to_vec(),
            name: name.into(),
            ip: ip.into(),
            created_at: now,
            last_seen_at: now,
            revoked_at: None,
        };
        self.application.save_device(device.clone()).await?;
        let entry = Arc::new(Entry {
            device,
            seen: AtomicU64::new(now),
            persisted: AtomicU64::new(now),
            closed: self.shutdown.child_token(),
        });
        let mut entries = self.entries.write();
        Arc::make_mut(&mut entries).insert(id.clone(), entry);
        let cookie = HeaderValue::from_str(&format!(
            "{}=v2.{id}.{secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000",
            self.cookie_name
        ))
        .map_err(|_| HttpError::public(500, "session_unavailable", "Session unavailable."))?;
        Ok((cookie, id))
    }

    pub(in crate::gateway::http) fn authenticate(
        &self,
        headers: &HeaderMap,
    ) -> Option<CancellationToken> {
        let snapshot = self.entries.read().clone();
        for value in headers
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
        {
            for pair in value.split(';') {
                let Some((name, value)) = pair.trim().split_once('=') else {
                    continue;
                };
                if name != self.cookie_name {
                    continue;
                }
                let mut parts = value.split('.');
                let (Some("v2"), Some(id), Some(secret), None) =
                    (parts.next(), parts.next(), parts.next(), parts.next())
                else {
                    continue;
                };
                let hash = Sha256::digest(secret.as_bytes());
                let entry = snapshot.get(id);
                let target =
                    entry.map_or(&[0; 32][..], |entry| entry.device.secret_hash.as_slice());
                let matches = constant_time_eq(&hash, target);
                if let Some(entry) = entry
                    && matches
                    && !entry.closed.is_cancelled()
                {
                    let now = self.now();
                    entry.seen.fetch_max(now, Ordering::Relaxed);
                    self.touch(entry.clone(), now);
                    return Some(entry.closed.clone());
                }
            }
        }
        None
    }

    fn touch(&self, entry: Arc<Entry>, now: u64) {
        let previous = entry.persisted.load(Ordering::Relaxed);
        if now.saturating_sub(previous) < 900
            || entry
                .persisted
                .compare_exchange(previous, now, Ordering::Relaxed, Ordering::Relaxed)
                .is_err()
        {
            return;
        }
        let application = self.application.clone();
        tokio::spawn(async move {
            if application
                .touch_device(entry.device.id.clone(), now)
                .await
                .is_err()
            {
                let _ = entry.persisted.compare_exchange(
                    now,
                    previous,
                    Ordering::Relaxed,
                    Ordering::Relaxed,
                );
            }
        });
    }

    pub(in crate::gateway::http) fn get(&self, id: &str) -> Option<PairedDevice> {
        self.entries.read().get(id).map(|entry| {
            let mut device = entry.device.clone();
            device.last_seen_at = entry.seen.load(Ordering::Relaxed);
            device
        })
    }

    pub(in crate::gateway::http) fn list(&self) -> Vec<PairedDevice> {
        let mut devices: Vec<_> = self
            .entries
            .read()
            .values()
            .map(|entry| {
                let mut device = entry.device.clone();
                device.last_seen_at = entry.seen.load(Ordering::Relaxed);
                device
            })
            .collect();
        devices.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
        devices
    }

    pub(in crate::gateway::http) async fn revoke(
        &self,
        id: Option<String>,
    ) -> Result<(), HttpError> {
        let _change = self.changes.lock().await;
        self.application
            .revoke_devices(id.clone(), self.now())
            .await?;
        let mut entries = self.entries.write();
        Arc::make_mut(&mut entries).retain(|key, entry| {
            if id.as_ref().is_none_or(|id| key == id) {
                entry.closed.cancel();
                false
            } else {
                true
            }
        });
        Ok(())
    }
}
