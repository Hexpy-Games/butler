//! Durable capture receipts; canonical instruction writes stay under the shared lease.
use super::*;
use inventory::{Entry, read_json, write_json};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};
use transaction::Request;
static SERIAL: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
static WORK: std::sync::LazyLock<parking_lot::Mutex<HashSet<PathBuf>>> =
    std::sync::LazyLock::new(|| parking_lot::Mutex::new(HashSet::new()));
#[derive(Serialize, Deserialize)]
struct Captured {
    request: Request,
    entry: Entry,
    text: String,
    fence: String,
    order: i64,
    submitted: ExplicitMemoryUpdateInput,
    #[serde(default)]
    discarded_reason: Option<String>,
}
fn path(root: &Path, operation: &str) -> PathBuf {
    root.join("captures")
        .join(format!("{}.json", sha256(operation.as_bytes())))
}
fn current_path(root: &Path, record: &str) -> PathBuf {
    root.join("capture-current")
        .join(format!("{}.json", sha256(record.as_bytes())))
}
fn index_capture(root: &Path, row: &Captured) -> CognitionResult<()> {
    let operation = row
        .submitted
        .operation_id
        .as_deref()
        .ok_or_else(|| failure("rule_operation_required"))?;
    butler_platform::secure_fs::create_private_dir_all(&root.join("capture-current"))
        .map_err(failure_source)?;
    write_json(&current_path(root, &row.entry.record_id), &operation)
}
pub(super) fn recover_capture_index(root: &Path) -> CognitionResult<()> {
    for (_, row) in captures(root)? {
        if current(root, &row)? {
            index_capture(root, &row)?;
        }
    }
    Ok(())
}
/// Exact record lookup; completed captures leave harmless pointers to absent files.
pub(super) fn latest_capture_revision(
    root: &Path,
    record: &str,
) -> CognitionResult<Option<String>> {
    let Some(operation) = read_json::<String>(&current_path(root, record))? else {
        return Ok(None);
    };
    let Some(row) = read_json::<Captured>(&path(root, &operation))? else {
        return Ok(None);
    };
    if row.entry.record_id != record {
        return Err(failure("rule_capture_index_mismatch"));
    }
    Ok(current(root, &row)?.then_some(row.entry.revision))
}
fn fence(root: &Path, project: Option<&str>) -> CognitionResult<String> {
    Ok(read_json(
        &root
            .join("fences")
            .join(sha256(project.unwrap_or("global").as_bytes())),
    )?
    .unwrap_or_default())
}
fn captures(root: &Path) -> CognitionResult<Vec<(PathBuf, Captured)>> {
    let directory = match fs::read_dir(root.join("captures")) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(failure_source(e)),
    };
    let mut rows = vec![];
    for file in directory {
        let path = file.map_err(failure_source)?.path();
        if path.extension().is_some_and(|e| e == "json")
            && let Some(receipt) = read_json(&path)?
        {
            rows.push((path, receipt));
        }
    }
    rows.sort_by_key(|(_, row): &(PathBuf, Captured)| row.order);
    Ok(rows)
}
fn current(root: &Path, row: &Captured) -> CognitionResult<bool> {
    Ok(row.fence == fence(root, row.entry.project_id.as_deref())?)
}
pub(super) fn pending_entry(root: &Path, handle: &str) -> CognitionResult<Option<Entry>> {
    for (_, row) in captures(root)? {
        if row.entry.handle == handle && current(root, &row)? {
            return Ok(Some(row.entry));
        }
    }
    Ok(None)
}
pub(super) fn overlay(
    root: &Path,
    mut rows: Vec<RememberedRule>,
) -> CognitionResult<Vec<RememberedRule>> {
    for (_, receipt) in captures(root)? {
        if !current(root, &receipt)? {
            continue;
        }
        let operation = match &receipt.request {
            Request::Remember { input, .. } => input.operation_id.as_deref().unwrap_or(""),
            Request::Forget { .. } => continue,
        };
        if root
            .join("operations")
            .join(format!("{}.json", sha256(operation.as_bytes())))
            .exists()
        {
            continue;
        }
        rows.retain(|row| row.handle != receipt.entry.handle);
        rows.push(RememberedRule {
            handle: receipt.entry.handle,
            text: receipt.text,
            revision: receipt.entry.revision,
            project_id: receipt.entry.project_id,
            duration: receipt.entry.duration,
            expires_at: receipt.entry.expires_at,
            scope_session_id: receipt.entry.scope_session_id,
        });
        WORK.lock().insert(root.to_owned());
    }
    let mut active = vec![];
    for row in rows {
        if !super::lifetime::ended(root, row.scope_session_id.as_deref())? {
            active.push(row);
        }
    }
    let mut rows = active;
    rows.retain(|row| {
        row.expires_at.as_deref().is_none_or(|iso| {
            chrono::DateTime::parse_from_rfc3339(iso)
                .is_ok_and(|t| t.timestamp_millis() > chrono::Utc::now().timestamp_millis())
        })
    });
    Ok(rows)
}
impl RememberedRuleOwner {
    pub(super) async fn capture(
        &self,
        input: ExplicitMemoryUpdateInput,
        target: Option<RememberedRuleTarget>,
        session: Option<String>,
    ) -> CognitionResult<RememberedRuleReceipt> {
        let owner = self.clone();
        let result = tokio::task::spawn_blocking(move || {
            capture_input(&owner, input, target, session.as_deref())
        })
        .await
        .map_err(failure_source)??;
        self.coordinator.invalidate_inventory();
        crate::cognition::signal_memory_work();
        Ok(result)
    }
    /// Drain only after a capture/change signal; no idle filesystem probes.
    pub(crate) async fn drain_captures(&self) -> CognitionResult<usize> {
        if !WORK.lock().remove(&self.root()) {
            return Ok(0);
        }
        let owner = self.clone();
        let result = tokio::task::spawn_blocking(move || {
            owner.authority()?;
            let lock = owner.environment.consolidation_lock(&owner.data_root);
            let Some(lease) = owner
                .coordinator
                .try_acquire(&CognitionWriteAcquire::immediate(
                    lock.clone(),
                    "instruction_capture",
                ))
                .map_err(CognitionError::from)?
            else {
                return Err(failure("rule_write_busy"));
            };
            lease.assert_for_path(&lock).map_err(CognitionError::from)?;
            let result = drain_locked(&owner).map_err(|error| owner.pending_error(error));
            let released = lease.release(result.is_ok()).map_err(CognitionError::from);
            result.and_then(|count| released.map(|()| count))
        })
        .await
        .map_err(failure_source)?;
        if result.is_err() {
            WORK.lock().insert(self.root());
        }
        result
    }
}
fn pending_receipt(entry: &Entry, operation_id: String, replayed: bool) -> RememberedRuleReceipt {
    RememberedRuleReceipt {
        rule: entry.handle.clone(),
        operation_id,
        state: "pending".into(),
        replayed,
        recall_state: None,
    }
}
pub(super) fn drain_locked(owner: &RememberedRuleOwner) -> CognitionResult<usize> {
    let root = owner.root();
    ensure_data_authority(
        &owner.data_root,
        &[&root.join("captures"), &root.join("capture-receipts")],
    )?;
    let captures = captures(&root)?;
    let count = captures.len();
    for (path, mut row) in captures {
        if current(&root, &row)? {
            transaction::run(owner, Some(row.request.clone()))?;
        } else {
            row.discarded_reason = Some("project_reset".into());
            write_json(&path, &row)?;
        }
        let _serial = SERIAL.lock();
        let directory = root.join("capture-receipts");
        butler_platform::secure_fs::create_private_dir_all(&directory).map_err(failure_source)?;
        fs::rename(
            &path,
            directory.join(
                path.file_name()
                    .ok_or_else(|| failure("instruction_receipt_path"))?,
            ),
        )
        .map_err(failure_source)?;
        butler_platform::secure_fs::sync_path(&directory).map_err(failure_source)?;
    }
    if count > 0 {
        butler_platform::secure_fs::sync_path(root.join("captures")).map_err(failure_source)?;
    }
    Ok(count)
}
/// Called under the already-held reset lease; drains before capturing exact targets.
pub fn fence_instruction_project(
    data: &Path,
    environment: &CognitionPathEnvironment,
    coordinator: &CognitionWriteCoordinator,
    project: &str,
) -> CognitionResult<Vec<RememberedRuleTarget>> {
    let publisher = Arc::new(CompletionPublisher::new(
        data,
        environment,
        Arc::new(|| chrono::Utc::now().to_rfc3339()),
    ));
    let owner = RememberedRuleOwner::new(
        data.to_owned(),
        environment.clone(),
        Arc::new(coordinator.clone()),
        publisher,
    );
    owner.authority()?;
    drain_locked(&owner)?;
    let _serial = SERIAL.lock();
    let root = owner.root();
    let targets = Inventory::read(&root)?
        .scopes
        .values()
        .flat_map(|rows| rows.values())
        .filter(|entry| entry.state == "active" && entry.project_id.as_deref() == Some(project))
        .map(|entry| RememberedRuleTarget {
            handle: entry.handle.clone(),
            expected_revision: entry.revision.clone(),
            project_id: entry.project_id.clone(),
        })
        .collect();
    let directory = root.join("fences");
    ensure_data_authority(data, &[&directory])?;
    butler_platform::secure_fs::create_private_dir_all(&directory).map_err(failure_source)?;
    write_json(
        &directory.join(sha256(project.as_bytes())),
        &uuid::Uuid::new_v4().to_string(),
    )?;
    Ok(targets)
}

pub(super) fn pending_text(root: &Path, id: &str) -> CognitionResult<Option<String>> {
    for (_, row) in captures(root)? {
        if row.entry.record_id == id && current(root, &row)? {
            return Ok(Some(row.text));
        }
    }
    Ok(None)
}

pub(super) fn pending_revision(
    root: &Path,
    target: &RememberedRuleTarget,
) -> CognitionResult<Option<Entry>> {
    for (_, row) in captures(root)? {
        if row.entry.handle == target.handle
            && row.entry.revision == target.expected_revision
            && current(root, &row)?
        {
            return Ok(Some(row.entry));
        }
    }
    Ok(None)
}

fn capture_input(
    owner: &RememberedRuleOwner,
    input: ExplicitMemoryUpdateInput,
    target: Option<RememberedRuleTarget>,
    session: Option<&str>,
) -> CognitionResult<RememberedRuleReceipt> {
    let _serial = SERIAL.lock();
    owner.authority()?;
    let root = owner.root();
    let operation = input
        .operation_id
        .clone()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| failure("rule_operation_required"))?;
    let file = path(&root, &operation);
    ensure_data_authority(&owner.data_root, &[&file])?;
    let completed = root
        .join("capture-receipts")
        .join(format!("{}.json", sha256(operation.as_bytes())));
    if let Some(row) = read_json::<Captured>(&file)?.or(read_json(&completed)?) {
        if row.submitted.text != input.text
            || row.submitted.project_id != input.project_id
            || row.submitted.duration != input.duration
            || row.submitted.scope_session_id != input.scope_session_id
        {
            return Err(failure("rule_operation_conflict"));
        }
        let mut receipt = pending_receipt(&row.entry, operation, true);
        if completed.exists() {
            receipt.state = if row.discarded_reason.is_some() {
                "forgotten"
            } else {
                "active"
            }
            .into();
        }
        return Ok(receipt);
    }
    let submitted = input.clone();
    let duration = input.duration.as_deref().unwrap_or("always");
    if !["always", "7 days", "this chat"].contains(&duration) {
        return Err(failure("instruction_duration_invalid"));
    }
    let request = prepare_request(&root, input, target, session)?;
    let intent = transaction::prepare(owner, request.clone())?;
    let row = Captured {
        discarded_reason: None,
        submitted,
        request,
        fence: fence(&root, intent.entry.project_id.as_deref())?,
        entry: intent.entry,
        text: intent.text,
        order: chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default(),
    };
    butler_platform::secure_fs::create_private_dir_all(&root.join("captures"))
        .map_err(failure_source)?;
    write_json(&file, &row)?;
    index_capture(&root, &row)?;
    WORK.lock().insert(root);
    Ok(pending_receipt(&row.entry, operation, false))
}

fn prepare_request(
    root: &Path,
    mut input: ExplicitMemoryUpdateInput,
    mut target: Option<RememberedRuleTarget>,
    session: Option<&str>,
) -> CognitionResult<Request> {
    let existing = list_remembered_rules(root, Some(input.project_id.as_deref()))?;
    if target.is_none() {
        target = existing
            .iter()
            .find(|row| {
                row.project_id == input.project_id
                    && (row.scope_session_id == input.scope_session_id
                        || (input.duration.as_deref().unwrap_or("always") == "always"
                            && session.is_some()
                            && row.scope_session_id.as_deref() == session))
                    && row
                        .text
                        .split_whitespace()
                        .eq(input.text.split_whitespace())
            })
            .map(|row| RememberedRuleTarget {
                handle: row.handle.clone(),
                expected_revision: row.revision.clone(),
                project_id: row.project_id.clone(),
            });
    }
    if target.as_ref().is_some_and(|target| {
        existing.iter().any(|row| {
            row.handle == target.handle
                && row.expires_at.is_some()
                && row.scope_session_id == input.scope_session_id
                && row
                    .text
                    .split_whitespace()
                    .eq(input.text.split_whitespace())
        })
    }) {
        input.duration = Some("always".into());
        input.expires_at = None;
        input.scope_session_id = None;
    }
    if input.expires_at.is_none() {
        input.expires_at = match input.duration.as_deref().unwrap_or("always") {
            "7 days" => Some((chrono::Utc::now() + chrono::Duration::days(7)).to_rfc3339()),
            "this chat" => Some((chrono::Utc::now() + chrono::Duration::hours(24)).to_rfc3339()),
            _ => None,
        };
    }
    Ok(Request::Remember { input, target })
}

/// Report this operation's receipt, even when another consumer drained it first.
pub(super) async fn settled_receipt(
    root: PathBuf,
    mut receipt: RememberedRuleReceipt,
) -> RememberedRuleReceipt {
    let fallback = receipt.clone();
    tokio::task::spawn_blocking(move || {
        let path = root
            .join("capture-receipts")
            .join(format!("{}.json", sha256(receipt.operation_id.as_bytes())));
        if let Ok(Some(row)) = read_json::<Captured>(&path) {
            receipt.state = if row.discarded_reason.is_some() {
                "forgotten"
            } else {
                "active"
            }
            .into();
            if receipt.state == "active" {
                receipt.recall_state = Some(
                    if row.entry.expires_at.is_some() || row.entry.scope_session_id.is_some() {
                        "prompt_only"
                    } else {
                        "pending"
                    }
                    .into(),
                );
            }
        }
        receipt
    })
    .await
    .unwrap_or(fallback)
}
