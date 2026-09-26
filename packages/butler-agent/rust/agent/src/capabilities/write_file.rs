mod definition;

pub(super) use definition::definition;

use serde_json::{Value, json};

use super::{CapabilityError, CapabilityInvocation, arguments, mutation_evidence};
use crate::workspace::{MutationCommand, MutationOutcome, WorkspaceMutations, WriteMutation};

pub(super) async fn execute(
    owner: &WorkspaceMutations,
    input: CapabilityInvocation<'_>,
) -> Result<Value, CapabilityError> {
    let args = match arguments::parse(input.call) {
        Ok(args) => args,
        Err((error, detail)) => {
            return Ok(json!({"ok":false,"error":error,"detail":detail,
                "message":"Tool arguments must be a JSON object.",
                "recovery_hint":"Retry write_file with path, content, and overwrite.",
                "evidence_capability_receipts":mutation_evidence::failure("write_file", error, &[], &[], &[], &[])}));
        }
    };
    let root = arguments::root(&input, &args)?;
    let requested = args
        .get("path")
        .and_then(Value::as_str)
        .map(crate::public_text::trim_js_whitespace)
        .unwrap_or("")
        .to_owned();
    let content = args.get("content").and_then(Value::as_str);
    let overwrite = match args.get("overwrite") {
        None => Some(false),
        Some(Value::Bool(value)) => Some(*value),
        _ => None,
    };
    let create_parents = args.get("create_parents") == Some(&Value::Bool(true));
    if requested.is_empty() || content.is_none() || overwrite.is_none() {
        return Ok(failure(
            &root,
            &requested,
            "invalid_arguments",
            "write_file requires path, content, and boolean overwrite.",
            "Retry with path, content, and overwrite=false or true.",
        ));
    }
    if !arguments::allowed(&input, "write_file:workspace") {
        return Ok(failure(
            &root,
            &requested,
            "tool_not_admitted",
            "The write effect is not admitted for this Steward task.",
            "Use only the exact mutation capability in the delegated packet.",
        ));
    }
    if !arguments::scope(&requested, input.mutation_scope) {
        return Ok(failure(
            &root,
            &requested,
            "invalid_arguments",
            "The requested path is outside the delegated mutation scope.",
            "Retry only within the immutable Steward mutation scope.",
        ));
    }
    let expected_sha256 = match arguments::sha256(args.get("expected_sha256")) {
        Ok(value) => value,
        Err(()) => {
            return Ok(failure(
                &root,
                &requested,
                "invalid_arguments",
                "expected_sha256 must be a 64-character hexadecimal SHA-256 digest.",
                "Retry with the complete current lowercase or uppercase SHA-256.",
            ));
        }
    };
    let context = arguments::context(&input, root);
    let command = MutationCommand::Write(WriteMutation {
        context,
        path: requested,
        content: content.expect("validated").to_owned(),
        overwrite: overwrite.expect("validated"),
        create_parents,
        expected_sha256,
    });
    let receiver = owner.submit(command).map_err(owner_error)?;
    let (outcome, elapsed) = receiver
        .await
        .map_err(|_| CapabilityError {
            code: "workspace_mutation_completion_lost".into(),
        })?
        .map_err(owner_error)?;
    let MutationOutcome::Write(result) = outcome else {
        unreachable!("write command outcome")
    };
    Ok(match result {
        Ok(committed) => {
            let mut result = json!({
                "ok":true,"path":committed.path,"created":committed.created,
                "overwritten":!committed.created,"bytes":committed.bytes,
                "after_sha256":committed.after_sha256,"atomic_write":true,
                "create_parents":create_parents,
                "metrics":{"elapsed_ms":elapsed.as_millis() as u64,
                    "files_written":1,"bytes_written":committed.bytes},
                "evidence_receipts":mutation_evidence::execution("write_file",
                    format!("{} workspace file {}", if committed.created {"Created"} else {"Overwrote"}, committed.path),
                    write_reference(&committed, create_parents)),
                "evidence_capability_receipts":mutation_evidence::success("write_file",
                    Some(&committed.path), &[], &[], if committed.created {
                        mutation_evidence::MutationOperation::Created
                    } else {
                        mutation_evidence::MutationOperation::Overwritten
                    }, committed.bytes),
            });
            if let Some(before) = &committed.before_sha256 {
                result["before_sha256"] = json!(before);
            }
            if committed.cleanup_failed {
                result["cleanup_failed"] = json!(true);
            }
            if let Some(detail) = &committed.changed_file {
                result["changed_file"] = super::edit_file::changed_file_value(detail);
            }
            result
        }
        Err(failed) => {
            let mut result = json!({"ok":false,"error":failed.error,
                "message":failed.message,"recovery_hint":failed.recovery_hint,
                "evidence_capability_receipts":mutation_evidence::failure("write_file", failed.error, &[], &[], &[], &[])});
            if let Some(path) = &failed.path {
                result["path"] = json!(path);
            }
            if let Some(before) = &failed.before_sha256 {
                result["before_sha256"] = json!(before);
            }
            if let Some(expected) = &failed.expected_sha256 {
                result["expected_sha256"] = json!(expected);
            }
            if let Some(guard) = &failed.guard {
                result["guard"] = guard.public_rejection();
            }
            result
        }
    })
}

fn failure(
    root: &std::path::Path,
    requested: &str,
    error: &str,
    message: &str,
    hint: &str,
) -> Value {
    let safe = safe_result_path(root, requested);
    let mut value = json!({"ok":false,"error":error,"message":message,"recovery_hint":hint,
        "evidence_capability_receipts":mutation_evidence::failure("write_file",error,&[],&[],&[],&[])});
    if let Some(safe) = safe {
        value["path"] = json!(safe);
    }
    value
}

fn safe_result_path(root: &std::path::Path, requested: &str) -> Option<String> {
    let candidate = if std::path::Path::new(requested).is_absolute() {
        std::path::Path::new(requested)
            .strip_prefix(root)
            .ok()?
            .to_string_lossy()
            .into_owned()
    } else {
        requested.to_owned()
    };
    crate::workspace::safe_workspace_path(&candidate).map(str::to_owned)
}

fn write_reference(committed: &crate::workspace::CommittedFile, create_parents: bool) -> Value {
    let mut reference = json!({"path":committed.path,"created":committed.created,
        "overwritten":!committed.created,"after_sha256":committed.after_sha256,
        "atomic_write":true,"create_parents":create_parents});
    if let Some(before) = &committed.before_sha256 {
        reference["before_sha256"] = json!(before);
    }
    if committed.cleanup_failed {
        reference["cleanup_failed"] = json!(true);
    }
    reference
}

fn owner_error(error: crate::workspace::MutationOwnerError) -> CapabilityError {
    CapabilityError {
        code: error.code.into(),
    }
}
