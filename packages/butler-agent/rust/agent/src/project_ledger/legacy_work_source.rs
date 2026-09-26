//! Stable raw-R2 Project Ledger reads for the required legacy Work source port.

use std::{fs, path::Path};

use serde_json::{Map, Value, json};

use super::{
    NativeProjectLedger, ProjectLedgerReadError, active_reference, committed, records, source_head,
};
use crate::{
    btcc::{
        BtccError, LegacyProjectWorkRecord, LegacyProjectWorkReferencedRecord,
        LegacyProjectWorkSource, LegacyProjectWorkSourceSnapshot, PortFuture, digest_identity,
    },
    json as js,
    locale::LocaleCollation,
    public_text::trim_js_whitespace,
};

impl LegacyProjectWorkSource for NativeProjectLedger {
    fn load_open_work(
        &self,
        project_ref: String,
        program_ids: Vec<String>,
    ) -> PortFuture<'_, Option<LegacyProjectWorkSourceSnapshot>> {
        Box::pin(async move {
            self.run(move |data, collation| read(data, &project_ref, program_ids, collation))
                .await
                .map_err(|error| {
                    let code = match error {
                        ProjectLedgerReadError::Resolution(code)
                        | ProjectLedgerReadError::RecordShow(code)
                        | ProjectLedgerReadError::Owner(code)
                        | ProjectLedgerReadError::DashboardInternal(code)
                        | ProjectLedgerReadError::DashboardUnavailable(code) => code,
                        ProjectLedgerReadError::DashboardChanged => {
                            "project_work_legacy_source_changed"
                        }
                    };
                    BtccError::relayed(code, code)
                })
        })
    }
}

fn read(
    data: &Path,
    reference: &str,
    mut ids: Vec<String>,
    collation: &LocaleCollation,
) -> Result<Option<LegacyProjectWorkSourceSnapshot>, ProjectLedgerReadError> {
    ids.retain(|id| !id.is_empty());
    ids.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    ids.dedup();
    if ids.is_empty() {
        return Ok(None);
    }
    let root = if let Some(id) = reference.strip_prefix("project:") {
        if !active_reference::safe_id(id) {
            return Err(invalid());
        }
        let projects = data.join("project-ledger/projects");
        let root = projects.join(id);
        active_reference::canonical_containment(&projects, &root)?;
        root
    } else {
        // The source resolver has no workspace fallback for this legacy lookup.
        active_reference::resolve_workspace(data, "", reference)?
    };
    if !root.join("project.json").exists() || !root.join("ledger.jsonl").exists() {
        return Ok(None);
    }
    for _ in 0..2 {
        let before = source_head::observe(&root, collation)?;
        let mut snapshots = Vec::new();
        for id in &ids {
            let Some(body) = reference_body(&root, &format!("BTCC-PROGRAM-{id}"))? else {
                continue;
            };
            let program = canonical_body(&body)?;
            if program["programId"].as_str() != Some(id.as_str()) {
                return Err(invalid());
            }
            let revision = program["manifestRevision"]
                .as_f64()
                .filter(|value| {
                    value.is_finite()
                        && value.fract() == 0.0
                        && value.abs() <= 9_007_199_254_740_991.0
                })
                .ok_or_else(invalid)?;
            let planning = text(&program, "planningState")?;
            let frontier = text(&program, "frontier")?;
            let goal_ref = decode_ref(&program["goalContractRef"])?;
            // Decode before the openness decision, matching source decodeProgram.
            let works = decode_items(&program["works"], "work")?;
            let tasks = decode_items(&program["tasks"], "task")?;
            let criteria = decode_criteria(&program["criteria"])?;
            if planning != "unplanned" && matches!(frontier, "closed" | "cancelled") {
                continue;
            }
            let goal = goal_contract(&root, &goal_ref)?;
            let source_revision = digest_identity(&format!(
                "btcc-r2-project-work-import.v1\0{}\0{}\0{}\0{}\0{}",
                before.project_root.to_string_lossy(),
                before.source_sha256,
                before.source_file_count,
                id,
                js::stringify(&json!(revision)).map_err(|_| invalid())?,
            ));
            let planned = planning != "unplanned";
            snapshots.push(LegacyProjectWorkSourceSnapshot {
                source_program_id: id.clone(),
                source_revision,
                goal_contract: goal,
                plan: if planned {
                    program.get("plan").cloned().unwrap_or(Value::Null)
                } else {
                    Value::Null
                },
                works: if planned { works } else { Vec::new() },
                tasks: if planned { tasks } else { Vec::new() },
                referenced_records: if planned { criteria } else { Vec::new() },
            });
        }
        let after = source_head::observe(&root, collation)?;
        if before.project_root != after.project_root
            || before.source_sha256 != after.source_sha256
            || before.source_file_count != after.source_file_count
        {
            continue;
        }
        if snapshots.len() > 1 {
            return Err(ProjectLedgerReadError::RecordShow(
                "project_work_legacy_multiple_open_programs",
            ));
        }
        return Ok(snapshots.pop());
    }
    Err(ProjectLedgerReadError::RecordShow(
        "project_work_legacy_source_changed",
    ))
}

fn goal_contract(root: &Path, source: &Value) -> Result<Value, ProjectLedgerReadError> {
    let id = text(source, "id")?;
    let logical_id = format!("ledger-record:{id}");
    let body = reference_body(root, &logical_id)?.ok_or_else(invalid)?;
    let logical = canonical_body(&body)?;
    let record = logical["record"].as_object().ok_or_else(invalid)?;
    if logical["ref"]["id"].as_str() != Some(logical_id.as_str())
        || logical["sourceId"].as_str() != Some(id)
    {
        return Err(invalid());
    }
    let encoded = js::canonical_json(&logical["record"], js::CanonicalKeyOrder::Utf16Lexical)
        .map_err(|_| invalid())?;
    let sha = digest_identity(&encoded);
    if source["sha256"].as_str() != Some(sha.as_str())
        || digest_identity(&format!("btcc-goal-contract.v1\0{sha}")) != id
    {
        return Err(invalid());
    }
    let mut goal = Map::new();
    goal.insert("ref".into(), source.clone());
    goal.extend(record.clone());
    Ok(Value::Object(goal))
}

fn canonical_body(body: &str) -> Result<Value, ProjectLedgerReadError> {
    let value: Value = serde_json::from_str(body).map_err(|_| invalid())?;
    if !value.is_object()
        || js::canonical_json(&value, js::CanonicalKeyOrder::Utf16Lexical).map_err(|_| invalid())?
            != body
    {
        return Err(invalid());
    }
    Ok(value)
}

fn decode_ref(value: &Value) -> Result<Value, ProjectLedgerReadError> {
    Ok(json!({"id":text(value,"id")?,"sha256":text(value,"sha256")?}))
}

fn decode_items(
    value: &Value,
    key: &str,
) -> Result<Vec<LegacyProjectWorkRecord>, ProjectLedgerReadError> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| {
            let mut content = item[key].as_object().ok_or_else(invalid)?.clone();
            let reference = decode_ref(&item[key]["ref"])?;
            let id = text(&reference, "id")?.to_owned();
            content.insert("ref".into(), reference);
            Ok(LegacyProjectWorkRecord {
                record_id: id,
                status: text(item, "status")?.to_owned(),
                content: Value::Object(content),
            })
        })
        .collect()
}

fn decode_criteria(
    value: &Value,
) -> Result<Vec<LegacyProjectWorkReferencedRecord>, ProjectLedgerReadError> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| {
            let mut content = item.as_object().ok_or_else(invalid)?.clone();
            let reference = decode_ref(&item["ref"])?;
            let id = text(&reference, "id")?.to_owned();
            content.insert("ref".into(), reference);
            Ok(LegacyProjectWorkReferencedRecord {
                record_id: id,
                content: Value::Object(content),
            })
        })
        .collect()
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, ProjectLedgerReadError> {
    value.get(key).and_then(Value::as_str).ok_or_else(invalid)
}

fn reference_body(
    root: &Path,
    requested_id: &str,
) -> Result<Option<String>, ProjectLedgerReadError> {
    let mut found = None;
    for (relative, raw) in committed::read_all(root)? {
        if !relative.ends_with(".md") && !relative.ends_with(".json") {
            continue;
        }
        let Some(raw) = raw else {
            continue;
        };
        let metadata = if relative.ends_with(".json") {
            serde_json::from_str(&raw).map_err(|_| invalid())?
        } else {
            records::frontmatter(&raw).unwrap_or_else(|| json!({}))
        };
        let kind = metadata
            .get("kind")
            .and_then(Value::as_str)
            .filter(|kind| !kind.is_empty())
            .unwrap_or(if relative.starts_with("references/") {
                "reference"
            } else {
                "record"
            });
        let fallback = Path::new(&relative)
            .file_stem()
            .and_then(|id| id.to_str())
            .unwrap_or("");
        let id = metadata
            .get("id")
            .and_then(Value::as_str)
            .map(trim_js_whitespace)
            .filter(|id| !id.is_empty())
            .unwrap_or(fallback);
        if kind != "reference" || id != requested_id {
            continue;
        }
        if found.is_some() {
            return Err(ProjectLedgerReadError::RecordShow("ambiguous_record"));
        }
        // Source resolveRecord sees committed metadata; readRecordBody reads the physical body.
        let physical = fs::read(root.join(&relative)).map_err(|_| invalid())?;
        let raw = String::from_utf8_lossy(&physical);
        found = Some(if relative.ends_with(".md") {
            records::frontmatter_body_ref(&raw).to_owned()
        } else {
            String::new()
        });
    }
    Ok(found)
}

fn invalid() -> ProjectLedgerReadError {
    ProjectLedgerReadError::RecordShow("project_work_legacy_source_invalid")
}
