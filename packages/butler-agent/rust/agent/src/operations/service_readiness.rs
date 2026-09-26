//! Source foreground-executor readiness publication owned by the live service.

use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

const SCHEMA: &str = "butler.app-foreground-executor-readiness.v1";

pub(crate) struct ServiceReadiness {
    path: PathBuf,
    pid: u32,
    ready_at: String,
}

impl ServiceReadiness {
    /// Publish only after the native queue consumer and BTCC are initialized.
    pub(crate) fn publish(data_root: &Path, now_iso: &str, now_ms: i64) -> io::Result<Self> {
        let directory = data_root.join("state/app-foreground");
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&directory)?;
        let pid = std::process::id();
        let path = directory.join("executor-ready.json");
        let temporary = directory.join(format!("executor-ready.json.{pid}.{now_ms}.tmp"));
        let record = json!({
            "schema": SCHEMA, "pid": pid, "readyAt": now_iso, "rawTextIncluded": false,
        });
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&temporary)?;
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
        })
    }

    pub(crate) fn published_identity(&self) -> io::Result<Option<(u32, String)>> {
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

    pub(crate) fn startup_grace(data_root: &Path, now_ms: i64) -> io::Result<()> {
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
