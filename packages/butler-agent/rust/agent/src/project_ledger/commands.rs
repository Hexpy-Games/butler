//! Source-shaped Project Ledger CLI commands on the existing Ledger owner.

mod check;
mod contracts;
mod effect_update;
mod index;
mod lifecycle;
mod query;
mod record;
mod render;
mod show;

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::locale::LocaleCollation;

use contracts::{CliFailure, CommandContext};
pub(crate) use contracts::{LedgerCommand, LedgerCommandRequest};
pub(in crate::project_ledger) use effect_update::apply as apply_candidate_effect_update;

pub(in crate::project_ledger) fn execute_sync(
    data_root: &Path,
    request: &LedgerCommandRequest,
    collation: &LocaleCollation,
) -> Value {
    let label = request.command.label();
    let context = match CommandContext::new(data_root, &request.project_root) {
        Ok(context) => context,
        Err(error) => return envelope(label, Err(error)),
    };
    let result = match request.command {
        LedgerCommand::Status => index::status(&context, collation),
        LedgerCommand::Query => query::query(&context, &request.options, collation),
        LedgerCommand::Show => show::show(&context, &request.options),
        LedgerCommand::Check => check::check(&context, &request.options, collation),
        LedgerCommand::Index => index::write(&context, collation),
        LedgerCommand::Render => render::render(&context, &request.options, collation),
        LedgerCommand::RecordCreate
        | LedgerCommand::RecordUpdate
        | LedgerCommand::WorkCreate
        | LedgerCommand::TaskCreate
        | LedgerCommand::WorkUpdate
        | LedgerCommand::WorkComplete
        | LedgerCommand::TaskUpdate
        | LedgerCommand::TaskComplete
        | LedgerCommand::AttemptStart
        | LedgerCommand::AttemptSucceed
        | LedgerCommand::AttemptFail => {
            return match with_mutation_claim(&context.root, || {
                Ok(lifecycle::execute(&context.root, request, collation))
            }) {
                Ok(envelope) => envelope,
                Err(error) => envelope(label, Err(error)),
            };
        }
    };
    if result
        .as_ref()
        .err()
        .is_some_and(|error| error.code == "not_initialized")
    {
        return match request.command {
            LedgerCommand::Status => envelope(label, Ok(json!({"initialized":false}))),
            LedgerCommand::Query => envelope(
                label,
                Ok(json!({
                    "initialized":false,
                    "kind":option_string(&request.options,"kind").map(crate::public_text::trim_js_whitespace).filter(|value|!value.is_empty()),
                    "results":[],
                })),
            ),
            _ => envelope(label, result),
        };
    }
    envelope(label, result)
}

pub(in crate::project_ledger) fn refresh_index_after_mutation(
    project_root: &Path,
    record: Value,
) -> Value {
    index::refresh_after_mutation(project_root, record)
}

/// Apply one source record mutation inside a private publication candidate.
/// The command retains its own source index refresh and mutation claim.
pub(in crate::project_ledger) fn execute_candidate(
    root: &Path,
    command: LedgerCommand,
    options: Value,
    collation: &LocaleCollation,
) -> Value {
    let request = LedgerCommandRequest {
        project_root: root.to_path_buf(),
        command,
        options,
    };
    match with_mutation_claim(root, || Ok(lifecycle::execute(root, &request, collation))) {
        Ok(result) => result,
        Err(error) => envelope(request.command.label(), Err(error)),
    }
}

pub(in crate::project_ledger) fn render_candidate(
    root: &Path,
    view: &str,
    collation: &LocaleCollation,
) -> Result<(), ()> {
    let context = CommandContext {
        root: root.to_path_buf(),
    };
    render::render(&context, &json!({"view":view,"write":true}), collation)
        .map(|_| ())
        .map_err(|_| ())
}

pub(in crate::project_ledger) fn write_candidate_index(
    root: &Path,
    collation: &LocaleCollation,
) -> Result<(), ()> {
    let context = CommandContext {
        root: root.to_path_buf(),
    };
    index::write(&context, collation)
        .map(|_| ())
        .map_err(|_| ())
}

pub(in crate::project_ledger) fn candidate_check_errors(
    root: &Path,
    collation: &LocaleCollation,
) -> Result<bool, ()> {
    let context = CommandContext {
        root: root.to_path_buf(),
    };
    match check::check(&context, &json!({}), collation) {
        Ok(_) => Ok(false),
        Err(error) if error.code == "project_ledger_check_failed" => Ok(error
            .data
            .get("issues")
            .and_then(Value::as_array)
            .is_some_and(|issues| {
                issues
                    .iter()
                    .any(|issue| issue.get("severity").and_then(Value::as_str) == Some("error"))
            })),
        Err(_) => Err(()),
    }
}

pub(in crate::project_ledger) fn candidate_index_available(root: &Path) -> Result<bool, ()> {
    let index = index::read_index(root).map_err(|_| ())?;
    Ok(index.is_some_and(|index| {
        index.pointer("/index/available").and_then(Value::as_bool) == Some(true)
            && index.pointer("/index/stale").and_then(Value::as_bool) != Some(true)
    }))
}

pub(in crate::project_ledger) fn canonical_record_kinds(
    data_root: &Path,
    project_root: &Path,
    id: &str,
) -> Result<Vec<String>, ()> {
    let context = CommandContext::new(data_root, project_root).map_err(|_| ())?;
    let index = index::build(&context.root).map_err(|_| ())?;
    let mut kinds = index
        .get("records")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|record| record.get("id").and_then(Value::as_str) == Some(id))
        .filter_map(|record| {
            record
                .get("kind")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect::<Vec<_>>();
    kinds.sort();
    kinds.dedup();
    Ok(kinds)
}

pub(in crate::project_ledger::commands) fn envelope(
    command: &str,
    result: Result<Value, CliFailure>,
) -> Value {
    match result {
        Ok(data) => json!({
            "ok":true,"command":command,"data":data,"error":null,
            "privacy":{"rawTextIncluded":false,"secretsIncluded":false}
        }),
        Err(error) => json!({
            "ok":false,"command":command,"data":error.data,
            "error":{"code":error.code,"message":error.message,"details":error.details,"next":error.next},
            "privacy":{"rawTextIncluded":false,"secretsIncluded":false}
        }),
    }
}

pub(in crate::project_ledger::commands) fn io_failure() -> CliFailure {
    CliFailure::new("internal_error", "Project Ledger command could not finish")
}

pub(in crate::project_ledger::commands) fn with_mutation_claim<T>(
    root: &Path,
    mutation: impl FnOnce() -> Result<T, CliFailure>,
) -> Result<T, CliFailure> {
    crate::project_ledger::publication::with_mutation_claim(root, mutation)
        .map_err(|_| CliFailure::new("internal_error", "Project Ledger mutation claim failed"))?
}

pub(super) fn display_path(root: &Path, relative: &Path) -> String {
    let id = root.file_name().unwrap_or_default().to_string_lossy();
    let path = relative.to_string_lossy().replace('\\', "/");
    format!("project-ledger/projects/{id}/{path}")
}

pub(in crate::project_ledger::commands) fn now_iso() -> Result<String, CliFailure> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| io_failure())?;
    let date = chrono::DateTime::from_timestamp(elapsed.as_secs() as i64, elapsed.subsec_nanos())
        .ok_or_else(io_failure)?;
    Ok(date.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

pub(super) fn option_string<'a>(options: &'a Value, key: &str) -> Option<&'a str> {
    options.get(key).and_then(Value::as_str)
}

pub(super) fn option_truthy(options: &Value, key: &str) -> bool {
    options.get(key).is_some_and(|value| match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::String(value) => !value.is_empty(),
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        _ => true,
    })
}

pub(in crate::project_ledger::commands) fn contained_root(
    data_root: &Path,
    project_root: &Path,
) -> Result<PathBuf, CliFailure> {
    let projects = data_root.join("project-ledger/projects");
    let id = project_root
        .file_name()
        .and_then(|id| id.to_str())
        .ok_or_else(|| {
            CliFailure::new(
                "project_ledger_project_scope_mismatch",
                "Project Ledger scope does not match the active project",
            )
        })?;
    let expected = projects.join(id);
    if !crate::project_ledger::active_reference::safe_id(id) {
        return Err(CliFailure::new(
            "project_ledger_project_scope_mismatch",
            "Project Ledger scope does not match the active project",
        ));
    }
    crate::project_ledger::active_reference::canonical_containment(&projects, &expected).map_err(
        |_| {
            CliFailure::new(
                "project_ledger_project_scope_mismatch",
                "Project Ledger scope does not match the active project",
            )
        },
    )?;
    if expected.exists() {
        let actual = std::fs::canonicalize(&expected).map_err(|_| io_failure())?;
        let supplied = std::fs::canonicalize(project_root).map_err(|_| io_failure())?;
        if supplied != actual {
            return Err(CliFailure::new(
                "project_ledger_project_scope_mismatch",
                "Project Ledger scope does not match the active project",
            ));
        }
        Ok(actual)
    } else if project_root == expected {
        Ok(expected)
    } else {
        Err(CliFailure::new(
            "project_ledger_project_scope_mismatch",
            "Project Ledger scope does not match the active project",
        ))
    }
}
