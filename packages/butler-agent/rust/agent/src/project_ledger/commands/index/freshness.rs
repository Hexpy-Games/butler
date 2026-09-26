use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Value, json};

use super::super::{CliFailure, display_path, io_failure};
use crate::project_ledger::committed;

pub(super) fn source_max_mtime(root: &Path) -> Result<f64, CliFailure> {
    let mut paths = committed::record_files(root).map_err(|_| io_failure())?;
    let project = root.join("project.json");
    if project.exists() {
        paths.push(project);
    }
    paths.into_iter().try_fold(0.0_f64, |max, path| {
        let modified = fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .and_then(|time| {
                time.duration_since(UNIX_EPOCH)
                    .map_err(std::io::Error::other)
            })
            .map_err(|_| io_failure())?;
        Ok(max.max(modified.as_secs_f64() * 1000.0))
    })
}

pub(super) fn views(root: &Path, source_mtime: f64) -> Result<Value, CliFailure> {
    let mut views = Vec::with_capacity(3);
    for name in ["dashboard", "handoff", "roadmap"] {
        let relative = format!("views/{name}.md");
        let path = root.join(&relative);
        let display = display_path(root, Path::new(&relative));
        let value = match fs::metadata(&path) {
            Ok(metadata) => {
                let modified = metadata.modified().map_err(|_| io_failure())?;
                let elapsed = modified
                    .duration_since(UNIX_EPOCH)
                    .map_err(|_| io_failure())?;
                let updated =
                    DateTime::<Utc>::from(modified).to_rfc3339_opts(SecondsFormat::Millis, true);
                json!({"name":name,"path":display,"exists":true,
                    "stale":elapsed.as_secs_f64()*1000.0<source_mtime,"updatedAt":updated})
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                json!({"name":name,"path":display,"exists":false,"stale":true})
            }
            Err(_) => return Err(io_failure()),
        };
        views.push(value);
    }
    Ok(Value::Array(views))
}

pub(super) fn index(root: &Path, source_mtime: f64) -> Result<Value, CliFailure> {
    let relative = Path::new("index/project.json");
    let path = root.join(relative);
    let display = display_path(root, relative);
    match fs::metadata(&path) {
        Ok(metadata) => {
            let modified = metadata.modified().map_err(|_| io_failure())?;
            let elapsed = modified
                .duration_since(UNIX_EPOCH)
                .map_err(|_| io_failure())?;
            let updated =
                DateTime::<Utc>::from(modified).to_rfc3339_opts(SecondsFormat::Millis, true);
            Ok(
                json!({"available":true,"stale":elapsed.as_secs_f64()*1000.0<source_mtime,
                "generatedAt":updated,"path":display}),
            )
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(json!({"available":false,"stale":true,"generatedAt":null,"path":display}))
        }
        Err(_) => Err(io_failure()),
    }
}
