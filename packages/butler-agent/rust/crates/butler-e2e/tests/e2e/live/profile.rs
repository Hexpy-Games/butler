//! Force expiry only after the persistent profile's sibling gate is usable.
//! Never copy a rotating login or restore an old token over a refreshed one.
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use butler_e2e::e2e::{HarnessError, harness_error};
use butler_platform::{secrets::ChangeLock, secure_fs};
use serde_json::{Value, json};

pub(crate) struct ExpiryProbe {
    path: PathBuf,
    before: Value,
}

impl ExpiryProbe {
    pub(crate) fn begin(path: PathBuf) -> Result<Self, HarnessError> {
        let lock_guard = lock(&path)?;
        let before: Value = serde_json::from_slice(&fs::read(&path)?)?;
        if !before.is_object() {
            return Err(harness_error("OAuth profile must be a JSON object"));
        }
        let mut expired = before.clone();
        expired["expiresAt"] = json!(1);
        let probe = Self { path, before };
        let written = write(&probe.path, &expired);
        // A post-rename sync error also needs restoration. Release the gate
        // before the guard can run on an error return.
        drop(lock_guard);
        written?;
        Ok(probe)
    }

    pub(crate) fn verify(&self, now_epoch_millis: i64) -> Result<(), HarnessError> {
        let _lock = lock(&self.path)?;
        let after: Value = serde_json::from_slice(&fs::read(&self.path)?)?;
        let now = now_epoch_millis as f64;
        if after["expiresAt"].as_f64().unwrap_or(0.0) <= now {
            return Err(harness_error(
                "OAuth refresh did not persist a future expiry",
            ));
        }
        let renewed = credentials(&after) != credentials(&self.before)
            || after["last_refresh"] != self.before["last_refresh"]
            || after["updatedAt"] != self.before["updatedAt"];
        if !renewed {
            return Err(harness_error(
                "OAuth refresh did not persist renewal evidence",
            ));
        }
        Ok(())
    }

    fn restore_unrenewed(&self) -> Result<(), HarnessError> {
        let _lock = lock(&self.path)?;
        let mut current: Value = serde_json::from_slice(&fs::read(&self.path)?)?;
        if current["expiresAt"] != json!(1) || credentials(&current) != credentials(&self.before) {
            return Ok(());
        }
        if let Some(original) = self.before.get("expiresAt") {
            current["expiresAt"] = original.clone();
        } else if let Some(object) = current.as_object_mut() {
            object.remove("expiresAt");
        }
        write(&self.path, &current)?;
        Ok(())
    }
}

impl Drop for ExpiryProbe {
    fn drop(&mut self) {
        if self.restore_unrenewed().is_err() {
            // Paths and token values must never enter the failure log.
            eprintln!("OAuth expiry restoration failed; persistent profile needs inspection");
        }
    }
}

fn credentials(profile: &Value) -> (&Value, &Value, &Value) {
    (
        &profile["tokens"],
        &profile["accessToken"],
        &profile["refreshToken"],
    )
}

fn lock(path: &Path) -> Result<ChangeLock, HarnessError> {
    let mut name = path.as_os_str().to_owned();
    name.push(".lock");
    ChangeLock::acquire(Path::new(&name), Duration::from_secs(30)).map_err(|error| {
        harness_error(format!(
            "OAuth profile gate failed before expiry mutation: kind={:?}, os_code={:?}",
            error.kind(),
            error.raw_os_error()
        ))
    })
}

fn write(path: &Path, profile: &Value) -> Result<(), HarnessError> {
    let bytes = serde_json::to_vec_pretty(profile)?;
    secure_fs::replace_private(path, |file| file.write_all(&bytes), std::convert::identity)?;
    Ok(())
}
