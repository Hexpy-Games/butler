//! DATA-scoped web-search counters and usage events.

use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};

#[derive(Clone)]
pub(crate) struct WebSearchMetrics {
    data_root: PathBuf,
    gate: Arc<Mutex<()>>,
}

impl WebSearchMetrics {
    pub(crate) fn new(data_root: PathBuf) -> Self {
        Self {
            data_root,
            gate: Arc::new(Mutex::new(())),
        }
    }

    /// Metrics failures never change the search result or leak provider errors.
    pub(crate) fn record(&self, provider: &str, query: &str, error: Option<&str>) {
        let Ok(_guard) = self.gate.lock() else { return };
        let _ = self.record_locked(provider, query, error);
    }

    /// Read the search summary without creating DATA or following a path alias.
    pub(crate) fn summary(&self) -> Value {
        let fallback = json!({
            "requestCount": 0,
            "lastProvider": null,
            "lastQuery": null,
            "lastError": null,
        });
        let Ok(_guard) = self.gate.lock() else {
            return fallback;
        };
        let Ok(canonical_root) = ensure_data_root(&self.data_root) else {
            return fallback;
        };
        let runtime = self.data_root.join("runtime");
        let summary = runtime.join("web-search-metrics.json");
        match fs::symlink_metadata(&runtime) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return fallback;
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => return fallback,
            Err(_) => return fallback,
        };
        if !runtime
            .canonicalize()
            .is_ok_and(|path| path.starts_with(&canonical_root))
        {
            return fallback;
        }
        match fs::symlink_metadata(&summary) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return fallback;
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => return fallback,
            Err(_) => return fallback,
        };
        let Ok(raw) = read_json_if_present(&summary) else {
            return fallback;
        };
        json!({
            "requestCount": raw["requestCount"].as_u64().unwrap_or(0),
            "lastProvider": raw["lastProvider"].as_str(),
            "lastQuery": raw["lastQuery"].as_str(),
            "lastError": raw["lastError"].as_str(),
        })
    }

    fn record_locked(&self, provider: &str, query: &str, error: Option<&str>) -> io::Result<()> {
        let runtime = self.data_root.join("runtime");
        let metrics = self.data_root.join("metrics");
        create_private_dir(&self.data_root, &runtime)?;
        create_private_dir(&self.data_root, &metrics)?;
        let summary = runtime.join("web-search-metrics.json");
        ensure_regular_file(&self.data_root, &runtime, &summary)?;
        let current = read_json_if_present(&summary)?;
        let next = json!({
            "requestCount": current["requestCount"].as_u64().unwrap_or(0).saturating_add(1),
            "lastProvider": provider,
            "lastQuery": query,
            "lastError": error,
        });
        replace_json(&self.data_root, &summary, &next)?;
        let mut event = json!({"ts": now_millis(), "provider": provider, "error": error});
        event["rawTextStored"] = Value::Bool(false);
        let events = metrics.join("web-search-usage.jsonl");
        ensure_regular_file(&self.data_root, &metrics, &events)?;
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC);
        }
        let mut output = options.open(events)?;
        serde_json::to_writer(&mut output, &event).map_err(json_io_error)?;
        output.write_all(b"\n")
    }
}

fn create_private_dir(data_root: &std::path::Path, path: &std::path::Path) -> io::Result<()> {
    let canonical_root = ensure_data_root(data_root)?;
    if path.parent() != Some(data_root) {
        return Err(unsafe_metrics_path());
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(unsafe_metrics_path());
        }
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        match builder.mode(0o700).create(path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    #[cfg(not(unix))]
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(unsafe_metrics_path());
    }
    if !path.canonicalize()?.starts_with(&canonical_root) {
        return Err(unsafe_metrics_path());
    }
    Ok(())
}

fn ensure_data_root(data_root: &std::path::Path) -> io::Result<PathBuf> {
    let metadata = fs::symlink_metadata(data_root)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(unsafe_metrics_path());
    }
    data_root.canonicalize()
}

fn ensure_regular_file(
    data_root: &std::path::Path,
    parent: &std::path::Path,
    path: &std::path::Path,
) -> io::Result<()> {
    let canonical_root = ensure_data_root(data_root)?;
    if parent.parent() != Some(data_root) || path.parent() != Some(parent) {
        return Err(unsafe_metrics_path());
    }
    let parent_metadata = fs::symlink_metadata(parent)?;
    if parent_metadata.file_type().is_symlink() || !parent_metadata.is_dir() {
        return Err(unsafe_metrics_path());
    }
    if !parent.canonicalize()?.starts_with(&canonical_root) {
        return Err(unsafe_metrics_path());
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(unsafe_metrics_path())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn read_json_if_present(path: &std::path::Path) -> io::Result<Value> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC);
    }
    match options.open(path) {
        Ok(file) => Ok(serde_json::from_reader(file).unwrap_or_else(|_| json!({}))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(json!({})),
        Err(error) => Err(error),
    }
}

fn replace_json(
    data_root: &std::path::Path,
    path: &std::path::Path,
    value: &Value,
) -> io::Result<()> {
    let parent = path.parent().ok_or_else(unsafe_metrics_path)?;
    ensure_regular_file(data_root, parent, path)?;
    let temporary = path.with_file_name(format!(".web-search-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        serde_json::to_writer_pretty(&mut file, value).map_err(json_io_error)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn unsafe_metrics_path() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "unsafe web-search metrics path",
    )
}

fn json_io_error(error: serde_json::Error) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error)
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_millis())
}

#[cfg(test)]
mod tests {
    use super::WebSearchMetrics;
    use std::fs;

    #[cfg(unix)]
    #[test]
    fn metrics_writer_refuses_data_subdirectory_symlink_aliases() {
        let root =
            std::env::temp_dir().join(format!("web-search-metrics-{}", uuid::Uuid::new_v4()));
        let outside = root.join("outside");
        let data = root.join("data");
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(&data).unwrap();
        std::os::unix::fs::symlink(&outside, data.join("metrics")).unwrap();

        WebSearchMetrics::new(data).record("fixture", "private query", None);

        assert!(!outside.join("web-search-usage.jsonl").exists());
        assert!(!outside.join("web-search-metrics.json").exists());
        let _ = fs::remove_dir_all(root);
    }
}
