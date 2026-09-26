use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::btcc::{
    BtccError, EffectAdapter, EffectJournal, EffectRecord, RecoveryHint, WorkView,
    WorkspaceFileEditEffectAdapter, accepted_plan_effect_id, effect_input_sha256,
    normalized_workspace_effect_path, workspace_edit_batch_target,
};
use crate::workspace::{prepare_exact_text, read_effect_edit_target};

use super::{NativeGuidedFileEffects, PreparedGuidedFileEffect};

mod legacy;

struct Edit {
    path: String,
    hint: Option<usize>,
    old_text: String,
    new_text: String,
    expected: Option<String>,
}

struct State {
    before: String,
    text: String,
    original: String,
}

fn rejected(code: &str, message: impl Into<String>) -> BtccError {
    BtccError::new(code, message)
}
fn observed<'a>(states: &'a HashMap<String, State>, path: &str) -> Result<&'a State, BtccError> {
    states.get(path).ok_or_else(|| {
        rejected(
            "edit_file_target_unobserved",
            "The edit target was not observed.",
        )
    })
}
/// The adapter input: `{"edits":[..]}` for a batch, else the single entry.
fn candidate(batch: bool, entries: Vec<Value>) -> Result<Value, BtccError> {
    if batch {
        return Ok(json!({ "edits": entries }));
    }
    entries
        .into_iter()
        .next()
        .ok_or_else(|| rejected("invalid_arguments", "edit_file requires one edit."))
}
/// The normalized entries in call order.
fn normalized_entries(normalized: &Value, batch: bool) -> Result<Vec<&Value>, BtccError> {
    if !batch {
        return Ok(vec![normalized]);
    }
    normalized
        .get("edits")
        .and_then(Value::as_array)
        .map(|entries| entries.iter().collect())
        .ok_or_else(|| {
            rejected(
                "edit_file_reconciliation_mismatch",
                "The normalized batch has no edits.",
            )
        })
}
fn sha(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

pub(super) async fn prepare(
    owner: &NativeGuidedFileEffects,
    args: &Value,
    work: &WorkView,
    occurrence: &str,
    journal: &dyn EffectJournal,
) -> Result<PreparedGuidedFileEffect, BtccError> {
    let (mut edits, batch) = decode(args, owner)?;
    let prior = if let Some(plan) = &work.current_plan {
        let id = accepted_plan_effect_id(
            &work.work_id,
            &plan.plan_revision_id,
            "edit_file",
            occurrence,
        )
        .map_err(|error| rejected(&error.code, error.message))?;
        journal
            .find(id)
            .await
            .map_err(|error| rejected(&error.code, error.message))?
    } else {
        None
    };
    let mut states = HashMap::<String, State>::new();
    let mut actual_targets = HashMap::<PathBuf, String>::new();
    for edit in &mut edits {
        let (text, before, identity) = read_effect_edit_target(&owner.scope, &edit.path)
            .await
            .map_err(|error| rejected(&error.code, error.message))?;
        let canonical = actual_targets
            .entry(identity)
            .or_insert_with(|| edit.path.clone());
        edit.path.clone_from(canonical);
        if states.contains_key(&edit.path) {
            continue;
        }
        states.insert(
            edit.path.clone(),
            State {
                before,
                original: text.clone(),
                text,
            },
        );
    }
    let adapter: Arc<dyn EffectAdapter> = Arc::new(WorkspaceFileEditEffectAdapter::new(
        owner.scope.clone(),
        owner.registered_edit.clone(),
    ));
    let normalized = if let Some(prior) = &prior {
        recover(&edits, batch, &states, prior, &adapter)?
    } else {
        fresh(&edits, batch, &mut states, &adapter)?
    };
    let target = if batch {
        workspace_edit_batch_target(
            &edits
                .iter()
                .map(|edit| edit.path.clone())
                .collect::<Vec<_>>(),
        )
        .map_err(|error| rejected(&error.code, error.message))?
    } else {
        let Some(first) = edits.first() else {
            return Err(rejected(
                "invalid_arguments",
                "edit_file requires one edit.",
            ));
        };
        format!("workspace:{}", first.path)
    };
    Ok(PreparedGuidedFileEffect {
        target,
        input: normalized,
        adapter,
    })
}

fn decode(args: &Value, owner: &NativeGuidedFileEffects) -> Result<(Vec<Edit>, bool), BtccError> {
    let record = args.as_object().ok_or_else(|| {
        rejected(
            "edit_file_invalid_input",
            "edit_file input must be an object.",
        )
    })?;
    let batch = record.contains_key("edits");
    if batch && record.len() != 1 {
        return Err(rejected(
            "edit_file_mixed_input",
            "edit_file accepts either one single edit or a canonical edits batch.",
        ));
    }
    let entries: Vec<&Value> = if batch {
        record["edits"]
            .as_array()
            .filter(|items| (2..=20).contains(&items.len()))
            .ok_or_else(|| {
                rejected(
                    "edit_file_invalid_batch",
                    "edit_file edits must contain 2-20 entries.",
                )
            })?
            .iter()
            .collect()
    } else {
        vec![args]
    };
    let mut edits = Vec::with_capacity(entries.len());
    for (index, value) in entries.into_iter().enumerate() {
        let row = value.as_object().ok_or_else(|| {
            rejected(
                "edit_file_invalid_input",
                format!("edits[{index}] must be an object."),
            )
        })?;
        if let Some(unknown) = row.keys().find(|key| {
            !matches!(
                key.as_str(),
                "path" | "start_line" | "old_text" | "new_text" | "expected_sha256"
            )
        }) {
            return Err(rejected(
                "edit_file_invalid_input",
                format!("edit_file rejects unknown field {unknown}."),
            ));
        }
        let path = row
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| rejected("edit_file_invalid_path", "edit_file requires path."))?;
        let path = normalized_workspace_effect_path(&owner.scope, path)
            .map_err(|error| rejected(&error.code, error.message))?;
        let old_text = row
            .get("old_text")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                rejected(
                    "edit_file_invalid_old_text",
                    "edit_file requires non-empty old_text.",
                )
            })?;
        let new_text = row.get("new_text").and_then(Value::as_str).ok_or_else(|| {
            rejected(
                "edit_file_invalid_new_text",
                "edit_file requires string new_text.",
            )
        })?;
        let hint = match row.get("start_line") {
            None => None,
            Some(value) => Some(crate::json::saturating_usize(
                value
                    .as_f64()
                    .filter(|number| {
                        number.is_finite()
                            && number.fract() == 0.0
                            && (1.0..=9_007_199_254_740_991.0).contains(number)
                    })
                    .ok_or_else(|| {
                        rejected(
                            "edit_file_invalid_start_line",
                            "edit_file start_line must be positive.",
                        )
                    })?,
            )),
        };
        let expected = match row.get("expected_sha256") {
            None => None,
            Some(value) => Some(
                value
                    .as_str()
                    .filter(|text| {
                        text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_hexdigit())
                    })
                    .ok_or_else(|| {
                        rejected(
                            "edit_file_invalid_input",
                            "expected_sha256 must be a SHA-256 digest.",
                        )
                    })?
                    .to_ascii_lowercase(),
            ),
        };
        edits.push(Edit {
            path,
            hint,
            old_text: old_text.into(),
            new_text: new_text.into(),
            expected,
        });
    }
    Ok((edits, batch))
}

fn fresh(
    edits: &[Edit],
    batch: bool,
    states: &mut HashMap<String, State>,
    adapter: &Arc<dyn EffectAdapter>,
) -> Result<Value, BtccError> {
    let mut lines = Vec::with_capacity(edits.len());
    for (index, edit) in edits.iter().enumerate() {
        let Some(state) = states.get_mut(&edit.path) else {
            return Err(rejected(
                "edit_file_target_unobserved",
                "The edit target was not observed.",
            ));
        };
        if edit
            .expected
            .as_deref()
            .is_some_and(|value| value != state.before)
        {
            return Err(rejected(
                "expected_sha256_mismatch",
                "The file no longer matches expected_sha256.",
            ));
        }
        if edit.old_text == edit.new_text {
            return Err(rejected(
                "edit_file_no_change",
                format!("edits[{index}] requests no change."),
            ));
        }
        let (after, line) =
            prepare_exact_text(&state.text, &edit.old_text, &edit.new_text, edit.hint).map_err(
                |code| {
                    rejected(
                        code,
                        "The current file does not identify one exact old_text range.",
                    )
                },
            )?;
        state.text = after;
        lines.push(line);
    }
    if states.values().all(|state| state.original == state.text) {
        return Err(rejected(
            "edit_file_no_change",
            "The ordered edits leave every file unchanged.",
        ));
    }
    let entries = edits
        .iter()
        .zip(lines)
        .map(|(edit, line)| {
            let state = observed(states, &edit.path)?;
            Ok(
                json!({"path":edit.path,"start_line":line,"old_text":edit.old_text,
            "new_text":edit.new_text,"before_sha256":state.before,"after_sha256":sha(&state.text)}),
            )
        })
        .collect::<Result<Vec<_>, BtccError>>()?;
    adapter
        .normalize_input(&candidate(batch, entries)?)
        .map_err(|error| rejected(&error.code, error.message))
}

fn recover(
    edits: &[Edit],
    batch: bool,
    states: &HashMap<String, State>,
    prior: &EffectRecord,
    adapter: &Arc<dyn EffectAdapter>,
) -> Result<Value, BtccError> {
    let Some(first) = edits.first() else {
        return Err(rejected(
            "invalid_arguments",
            "edit_file requires one edit.",
        ));
    };
    let Some(hint) = &prior.recovery_hint else {
        if !batch {
            return legacy::recover(
                first,
                observed(states, &first.path)?,
                &prior.identity.input_sha256,
                adapter,
            );
        }
        return Err(rejected(
            "edit_file_reconciliation_mismatch",
            "The legacy edit intent has no durable recovery hint.",
        ));
    };
    let entries: Vec<Value> = match (batch, hint) {
        (
            false,
            RecoveryHint::Single {
                capability,
                start_line,
                before_sha256,
                after_sha256,
            },
        ) if capability == "edit_file" && *start_line > 0 => {
            vec![json!({"path":first.path,"start_line":start_line,
                "old_text":first.old_text,"new_text":first.new_text,
                "before_sha256":before_sha256,"after_sha256":after_sha256})]
        }
        (
            true,
            RecoveryHint::Batch {
                capability,
                entries: hints,
            },
        ) if capability == "edit_file" && hints.len() == edits.len() => edits
            .iter()
            .zip(hints)
            .map(|(edit, hint)| {
                if edit.path != hint.path || hint.start_line < 1 {
                    return Err(());
                }
                Ok(json!({"path":edit.path,"start_line":hint.start_line,
                    "old_text":edit.old_text,"new_text":edit.new_text,
                    "before_sha256":hint.before_sha256,"after_sha256":hint.after_sha256}))
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|()| {
                rejected(
                    "edit_file_reconciliation_mismatch",
                    "The durable edit path changed.",
                )
            })?,
        _ => {
            return Err(rejected(
                "edit_file_reconciliation_mismatch",
                "The durable edit hint does not match the call.",
            ));
        }
    };
    let normalized = adapter
        .normalize_input(&candidate(batch, entries)?)
        .map_err(|error| rejected(&error.code, error.message))?;
    let hash =
        effect_input_sha256(&normalized).map_err(|error| rejected(&error.code, error.message))?;
    if hash != prior.identity.input_sha256 {
        return Err(rejected(
            "edit_file_reconciliation_mismatch",
            "The durable edit identity changed.",
        ));
    }
    let mut prepared_before = HashMap::<&str, String>::new();
    let entries = normalized_entries(&normalized, batch)?;
    for (edit, entry) in edits.iter().zip(&entries) {
        let path = entry["path"].as_str().unwrap_or("");
        let state = observed(states, path)?;
        let before = entry["before_sha256"].as_str().unwrap_or("");
        let after = entry["after_sha256"].as_str().unwrap_or("");
        if edit
            .expected
            .as_deref()
            .is_some_and(|expected| expected != before)
        {
            return Err(rejected(
                "edit_file_reconciliation_mismatch",
                "The supplied expected_sha256 differs from the durable edit.",
            ));
        }
        if state.before != before && state.before != after {
            return Err(rejected(
                "edit_file_reconciliation_mismatch",
                "The file no longer matches the durable edit intent.",
            ));
        }
        if state.before == before {
            let text = prepared_before
                .entry(path)
                .or_insert_with(|| state.text.clone());
            let line =
                usize::try_from(entry["start_line"].as_u64().unwrap_or(0)).unwrap_or(usize::MAX);
            let (after_text, actual_line) =
                prepare_exact_text(text, &edit.old_text, &edit.new_text, Some(line)).map_err(
                    |_| {
                        rejected(
                            "edit_file_reconciliation_mismatch",
                            "The durable edit range is no longer exact.",
                        )
                    },
                )?;
            if actual_line != line {
                return Err(rejected(
                    "edit_file_reconciliation_mismatch",
                    "The durable edit line changed.",
                ));
            }
            *text = after_text;
        }
    }
    for (path, text) in prepared_before {
        let Some(first) = entries
            .iter()
            .find(|entry| entry["path"].as_str() == Some(path))
        else {
            return Err(rejected(
                "edit_file_reconciliation_mismatch",
                "The recovered edit has no durable entry.",
            ));
        };
        if sha(&text) != first["after_sha256"].as_str().unwrap_or("") {
            return Err(rejected(
                "edit_file_reconciliation_mismatch",
                "The recovered edit result no longer matches the durable hash.",
            ));
        }
    }
    Ok(normalized)
}
