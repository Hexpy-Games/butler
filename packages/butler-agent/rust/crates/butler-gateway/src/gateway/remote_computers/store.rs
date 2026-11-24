use super::{Computer, HttpError};
use butler_core::configuration::{lock_file_async, read_json_object, write_json_atomic};
use std::{
    collections::BTreeSet,
    io::Write,
    path::{Path, PathBuf},
};

fn read_sync(path: &Path) -> Result<Vec<Computer>, HttpError> {
    let value = read_json_object(path).map_err(|_| HttpError::Internal)?;
    if value.as_object().is_some_and(serde_json::Map::is_empty) {
        return Ok(Vec::new());
    }
    if value.get("version").and_then(serde_json::Value::as_u64) != Some(1) {
        return Err(HttpError::Internal);
    }
    serde_json::from_value(value.get("computers").cloned().ok_or(HttpError::Internal)?)
        .map_err(|_| HttpError::Internal)
}

pub(super) async fn read(path: PathBuf) -> Result<Vec<Computer>, HttpError> {
    tokio::task::spawn_blocking(move || read_sync(&path))
        .await
        .map_err(|_| HttpError::Internal)?
}

pub(super) fn unique_name(records: &[Computer], name: &str) -> Result<(), HttpError> {
    let name = name.to_lowercase();
    if records
        .iter()
        .any(|record| record.name.to_lowercase() == name)
    {
        return Err(HttpError::public(
            409,
            "computer_name_taken",
            "This computer name is already used.",
        ));
    }
    Ok(())
}

pub(super) async fn add(path: PathBuf, computer: Computer) -> Result<Computer, HttpError> {
    let guard = lock_file_async(&path)
        .await
        .map_err(|_| HttpError::Internal)?;
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let mut records = read_sync(&path)?;
        unique_name(&records, &computer.name)?;
        records.push(computer);
        write_json_atomic(
            &path,
            &serde_json::json!({"version": 1, "computers": records}),
        )
        .map_err(|_| HttpError::Internal)?;
        records.pop().ok_or(HttpError::Internal)
    })
    .await
    .map_err(|_| HttpError::Internal)?
}

pub(super) async fn delete(path: PathBuf, id: String) -> Result<(), HttpError> {
    let guard = lock_file_async(&path)
        .await
        .map_err(|_| HttpError::Internal)?;
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let mut records = read_sync(&path)?;
        let index = records
            .iter()
            .position(|record| record.id == id)
            .ok_or_else(|| HttpError::public(404, "computer_not_found", "Computer not found."))?;
        records.remove(index);
        write_json_atomic(
            &path,
            &serde_json::json!({"version": 1, "computers": records}),
        )
        .map_err(|_| HttpError::Internal)
    })
    .await
    .map_err(|_| HttpError::Internal)?
}

pub(super) async fn update(
    path: PathBuf,
    id: String,
    change: impl FnOnce(&mut Computer) + Send + 'static,
) -> Result<Computer, HttpError> {
    let guard = lock_file_async(&path)
        .await
        .map_err(|_| HttpError::Internal)?;
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let mut records = read_sync(&path)?;
        let computer = records
            .iter_mut()
            .find(|record| record.id == id)
            .ok_or_else(|| HttpError::public(404, "computer_not_found", "Computer not found."))?;
        change(computer);
        let updated = computer.clone();
        write_json_atomic(
            &path,
            &serde_json::json!({"version": 1, "computers": records}),
        )
        .map_err(|_| HttpError::Internal)?;
        Ok(updated)
    })
    .await
    .map_err(|_| HttpError::Internal)?
}

pub(super) async fn edit(
    path: PathBuf,
    id: String,
    name: String,
    change: impl FnOnce(&mut Computer) + Send + 'static,
) -> Result<Computer, HttpError> {
    let guard = lock_file_async(&path)
        .await
        .map_err(|_| HttpError::Internal)?;
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let mut records = read_sync(&path)?;
        let others: Vec<_> = records
            .iter()
            .filter(|record| record.id != id)
            .cloned()
            .collect();
        unique_name(&others, &name)?;
        let computer = records
            .iter_mut()
            .find(|record| record.id == id)
            .ok_or_else(|| HttpError::public(404, "computer_not_found", "Computer not found."))?;
        change(computer);
        let updated = computer.clone();
        write_json_atomic(
            &path,
            &serde_json::json!({"version": 1, "computers": records}),
        )
        .map_err(|_| HttpError::Internal)?;
        Ok(updated)
    })
    .await
    .map_err(|_| HttpError::Internal)?
}

pub(super) struct KnownHosts(pub PathBuf);

impl KnownHosts {
    pub(super) async fn write(lines: BTreeSet<String>) -> Result<Self, HttpError> {
        tokio::task::spawn_blocking(move || {
            let path =
                std::env::temp_dir().join(format!("butler-known-hosts-{}", uuid::Uuid::new_v4()));
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|_| HttpError::Internal)?;
            let guard = Self(path);
            for line in lines {
                writeln!(file, "{line}").map_err(|_| HttpError::Internal)?;
            }
            Ok(guard)
        })
        .await
        .map_err(|_| HttpError::Internal)?
    }

    pub(super) async fn lines(&self) -> Result<BTreeSet<String>, HttpError> {
        let text = tokio::fs::read_to_string(&self.0)
            .await
            .map_err(|_| HttpError::Internal)?;
        Ok(text.lines().map(str::to_owned).collect())
    }
}

impl Drop for KnownHosts {
    fn drop(&mut self) {
        let path = self.0.clone();
        tokio::task::spawn_blocking(move || {
            let _ = std::fs::remove_file(path);
        });
    }
}

pub(super) fn host_lines(records: &[Computer]) -> BTreeSet<String> {
    records
        .iter()
        .flat_map(|record| record.host_keys.iter().cloned())
        .collect()
}
