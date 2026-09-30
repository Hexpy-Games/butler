//! Source foreground-executor readiness publication owned by the live service.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use butler_platform::secure_fs;
use serde_json::{Value, json};

const SCHEMA: &str = "butler.app-foreground-executor-readiness.v1";

pub struct ServiceReadiness {
    path: PathBuf,
    pid: u32,
    ready_at: String,
    dispatch_ready: AtomicBool,
    dispatch_ready_changed: tokio::sync::Notify,
}

impl ServiceReadiness {
    /// Publish only after the native queue consumer and BTCC are initialized.
    pub fn publish(data_root: &Path, now_iso: &str, now_ms: i64) -> io::Result<Self> {
        let directory = data_root.join("state/app-foreground");
        secure_fs::create_private_dir_all(&directory)?;
        let pid = std::process::id();
        let path = directory.join("executor-ready.json");
        let temporary = directory.join(format!("executor-ready.json.{pid}.{now_ms}.tmp"));
        let record = json!({
            "schema": SCHEMA, "pid": pid, "readyAt": now_iso, "rawTextIncluded": false,
        });
        let result = (|| {
            let mut options = OpenOptions::new();
            options.write(true).create(true).truncate(true);
            let _ = secure_fs::owner_only(&mut options);
            let mut file = options.open(&temporary)?;
            serde_json::to_writer_pretty(&mut file, &record)?;
            file.write_all(b"\n")?;
            drop(file);
            fs::rename(&temporary, &path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result?;
        Ok(Self {
            path,
            pid,
            ready_at: now_iso.into(),
            dispatch_ready: AtomicBool::new(false),
            dispatch_ready_changed: tokio::sync::Notify::new(),
        })
    }

    /// Mark the point when the inbound dispatcher can accept turns.
    pub fn mark_dispatch_ready(&self) {
        self.dispatch_ready.store(true, Ordering::Release);
        self.dispatch_ready_changed.notify_waiters();
    }

    /// Wait for the first inbound poll without polling the readiness file.
    pub async fn wait_dispatch_ready(&self) {
        loop {
            let ready = self.dispatch_ready_changed.notified();
            tokio::pin!(ready);
            ready.as_mut().enable();
            if self.dispatch_ready() {
                return;
            }
            ready.await;
        }
    }

    pub fn dispatch_ready(&self) -> bool {
        self.dispatch_ready.load(Ordering::Acquire)
    }

    pub fn published_identity(&self) -> io::Result<Option<(u32, String)>> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let record: Value = serde_json::from_slice(&bytes)?;
        if record["schema"] == SCHEMA
            && record["pid"].as_u64() == Some(u64::from(self.pid))
            && record["readyAt"].as_str() == Some(self.ready_at.as_str())
            && record["rawTextIncluded"] == false
        {
            Ok(Some((self.pid, self.ready_at.clone())))
        } else {
            Ok(None)
        }
    }

    pub fn startup_grace(data_root: &Path, now_ms: i64) -> io::Result<()> {
        fs::create_dir_all(data_root.join("state"))?;
        fs::write(
            data_root.join("state/startup-grace-until"),
            format!("{}\n", now_ms as f64 / 1000.0 + 45.0),
        )
    }
}

impl Drop for ServiceReadiness {
    fn drop(&mut self) {
        let record = fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        if record.as_ref().is_some_and(|record| {
            record["schema"] == SCHEMA
                && record["pid"].as_u64() == Some(u64::from(self.pid))
                && record["readyAt"].is_string()
                && record["rawTextIncluded"] == false
        }) {
            let _ = fs::remove_file(&self.path);
        }
    }
}
