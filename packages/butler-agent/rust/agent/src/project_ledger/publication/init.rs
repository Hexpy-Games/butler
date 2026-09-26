//! First-use Project Ledger initialization under the canonical mutation claim.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use chrono::DateTime;
use serde::{Deserialize, Serialize};

use crate::btcc::ResolvedProjectWorkScope;

use super::contracts::ProjectWorkPublicationError;
use super::record;

const LAYOUT_DIRS: &[&str] = &[
    "initiatives",
    "work",
    "decisions",
    "risks",
    "specs",
    "reports",
    "plans",
    "handoffs",
    "references",
    "roadmaps",
    "index",
    "views",
];

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MutationClaim {
    schema: String,
    claim_id: String,
    host_id: String,
    process_id: u32,
    process_started_at_ms: i64,
}

pub(super) fn ensure(
    data_root: &Path,
    scope: &ResolvedProjectWorkScope,
    display_name: &str,
) -> Result<(), ProjectWorkPublicationError> {
    let display_name = crate::public_text::trim_js_whitespace(display_name);
    if display_name.is_empty() {
        return Err(ProjectWorkPublicationError::Adapter(
            "project_ledger_init_name_required",
        ));
    }
    let root = canonical_target(data_root, scope)?;
    let project = root.join("project.json");
    let ledger = root.join("ledger.jsonl");
    if project.exists() && ledger.exists() {
        return Ok(());
    }
    let claim = claim_path(&root);
    let owner = current_claim()?;
    acquire(&claim, &owner)?;
    let result = (|| {
        if project.exists() && ledger.exists() {
            return Ok(());
        }
        fs::create_dir_all(&root).map_err(|_| io())?;
        for directory in LAYOUT_DIRS {
            fs::create_dir_all(root.join(directory)).map_err(|_| io())?;
        }
        let timestamp = now_iso()?;
        if !project.exists() {
            let value = serde_json::json!({
                "schema":"project-ledger.project.v1",
                "id": scope.ledger_project_id,
                "name": display_name,
                "status":"active",
                "createdAt":timestamp,
                "updatedAt":timestamp,
            });
            let mut bytes = serde_json::to_vec_pretty(&value).map_err(|_| io())?;
            bytes.push(b'\n');
            fs::write(&project, bytes).map_err(|_| io())?;
        }
        if !ledger.exists() {
            fs::write(&ledger, b"").map_err(|_| io())?;
        }
        let event = serde_json::json!({
            "schema":"project-ledger.event.v1",
            "ts":now_iso()?,
            "type":"project_initialized",
            "projectId":scope.ledger_project_id,
            "source":"project-ledger",
        });
        let mut line = crate::json::stringify(&event)
            .map_err(|_| io())?
            .into_bytes();
        line.push(b'\n');
        use std::io::Write;
        fs::OpenOptions::new()
            .append(true)
            .open(&ledger)
            .and_then(|mut file| file.write_all(&line))
            .map_err(|_| io())?;
        let bytes = fs::read(&project).map_err(|_| io())?;
        let _: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| {
            ProjectWorkPublicationError::Adapter("project_ledger_init_project_invalid_json")
        })?;
        Ok(())
    })();
    let release = release(&claim, &owner);
    result.and(release)
}

fn canonical_target(
    data_root: &Path,
    scope: &ResolvedProjectWorkScope,
) -> Result<PathBuf, ProjectWorkPublicationError> {
    record::safe_id(&scope.ledger_project_id)?;
    let projects = data_root.join("project-ledger/projects");
    fs::create_dir_all(&projects).map_err(|_| io())?;
    let canonical_projects = fs::canonicalize(&projects).map_err(|_| io())?;
    let expected = projects.join(&scope.ledger_project_id);
    if scope.ledger_root != expected {
        return Err(mismatch());
    }
    if expected.exists() {
        let actual = fs::canonicalize(&expected).map_err(|_| io())?;
        if actual != canonical_projects.join(&scope.ledger_project_id) {
            return Err(mismatch());
        }
    }
    Ok(expected)
}

fn claim_path(root: &Path) -> PathBuf {
    root.parent()
        .unwrap_or(root)
        .join(".project-ledger-locks")
        .join(format!(
            "{}.lock",
            root.file_name().unwrap_or_default().to_string_lossy()
        ))
}

/// Reuse the canonical mutation claim for derived CLI writes. The callback's
/// error stays distinct from claim acquisition/release failure.
pub(in crate::project_ledger) fn with_mutation_claim<T>(
    root: &Path,
    mutation: impl FnOnce() -> T,
) -> Result<T, ProjectWorkPublicationError> {
    let path = claim_path(root);
    let owner = current_claim()?;
    acquire(&path, &owner)?;
    let result = mutation();
    release(&path, &owner)?;
    Ok(result)
}

fn acquire(path: &Path, owner: &MutationClaim) -> Result<(), ProjectWorkPublicationError> {
    let parent = path.parent().ok_or_else(io)?;
    fs::create_dir_all(parent).map_err(|_| io())?;
    for _ in 0..2 {
        let candidate = parent.join(format!(
            "{}.candidate-{}",
            path.file_name().unwrap_or_default().to_string_lossy(),
            uuid::Uuid::new_v4()
        ));
        let mut bytes = serde_json::to_vec_pretty(owner).map_err(|_| io())?;
        bytes.push(b'\n');
        fs::write(&candidate, bytes).map_err(|_| io())?;
        let link = fs::hard_link(&candidate, path);
        let _ = fs::remove_file(candidate);
        match link {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let bytes = fs::read(path).map_err(|_| ProjectWorkPublicationError::Uncertain)?;
                let existing: serde_json::Value = serde_json::from_slice(&bytes)
                    .map_err(|_| ProjectWorkPublicationError::Uncertain)?;
                if existing.get("schema").and_then(serde_json::Value::as_str)
                    != Some("project-ledger.mutation-claim.v1")
                {
                    return Err(ProjectWorkPublicationError::Uncertain);
                }
                let previous: MutationClaim = serde_json::from_value(existing)
                    .map_err(|_| ProjectWorkPublicationError::Uncertain)?;
                if previous.host_id != owner.host_id {
                    return Err(ProjectWorkPublicationError::Uncertain);
                }
                let observed = process_started_ms(previous.process_id);
                if observed.is_some_and(|started| started == previous.process_started_at_ms) {
                    return Err(ProjectWorkPublicationError::Uncertain);
                }
                if observed.is_none() && process_alive(previous.process_id) {
                    return Err(ProjectWorkPublicationError::Uncertain);
                }
                let quarantine = path.with_extension(format!("dead-{}", previous.claim_id));
                fs::rename(path, &quarantine)
                    .map_err(|_| ProjectWorkPublicationError::Uncertain)?;
                let quarantined: MutationClaim =
                    serde_json::from_slice(&fs::read(&quarantine).map_err(|_| io())?)
                        .map_err(|_| ProjectWorkPublicationError::Uncertain)?;
                if quarantined.claim_id != previous.claim_id {
                    return Err(ProjectWorkPublicationError::Uncertain);
                }
                fs::remove_file(quarantine).map_err(|_| io())?;
            }
            Err(_) => return Err(io()),
        }
    }
    Err(ProjectWorkPublicationError::Uncertain)
}

fn release(path: &Path, owner: &MutationClaim) -> Result<(), ProjectWorkPublicationError> {
    let stored: MutationClaim = serde_json::from_slice(&fs::read(path).map_err(|_| io())?)
        .map_err(|_| ProjectWorkPublicationError::Uncertain)?;
    if stored.claim_id != owner.claim_id {
        return Err(ProjectWorkPublicationError::Uncertain);
    }
    fs::remove_file(path).map_err(|_| io())
}

fn current_claim() -> Result<MutationClaim, ProjectWorkPublicationError> {
    let process_id = std::process::id();
    let host_id = nix::unistd::gethostname()
        .map_err(|_| ProjectWorkPublicationError::Uncertain)?
        .to_string_lossy()
        .into_owned();
    let started = process_started_ms(process_id).ok_or(ProjectWorkPublicationError::Uncertain)?;
    Ok(MutationClaim {
        schema: "project-ledger.mutation-claim.v1".into(),
        claim_id: uuid::Uuid::new_v4().to_string(),
        host_id,
        process_id,
        process_started_at_ms: started,
    })
}

fn process_started_ms(pid: u32) -> Option<i64> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "lstart="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = std::str::from_utf8(&output.stdout).ok()?.trim();
    #[cfg(target_os = "macos")]
    let converted = Command::new("date")
        .args(["-j", "-f", "%a %b %e %T %Y", raw, "+%s"])
        .output()
        .ok()?;
    #[cfg(target_os = "linux")]
    let converted = Command::new("date")
        .args(["-d", raw, "+%s"])
        .output()
        .ok()?;
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    return None;
    if !converted.status.success() {
        return None;
    }
    std::str::from_utf8(&converted.stdout)
        .ok()?
        .trim()
        .parse::<i64>()
        .ok()?
        .checked_mul(1000)
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    use nix::sys::signal::kill;
    use nix::unistd::Pid;
    kill(Pid::from_raw(pid as i32), None).is_ok()
}
#[cfg(not(unix))]
fn process_alive(_pid: u32) -> bool {
    true
}

fn now_iso() -> Result<String, ProjectWorkPublicationError> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| io())?;
    let date = DateTime::from_timestamp(elapsed.as_secs() as i64, elapsed.subsec_nanos())
        .ok_or_else(io)?;
    Ok(date.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

fn io() -> ProjectWorkPublicationError {
    ProjectWorkPublicationError::Io("project_ledger_init_io_error")
}
fn mismatch() -> ProjectWorkPublicationError {
    ProjectWorkPublicationError::Adapter("project_work_scope_mismatch")
}
