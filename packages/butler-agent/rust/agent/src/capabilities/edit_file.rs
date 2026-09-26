mod definition;
mod normalize;
mod result;

pub(super) use definition::definition;
pub(super) use result::changed_file_value;

use serde_json::{Value, json};

use super::{CapabilityError, CapabilityInvocation, arguments, mutation_evidence};
use crate::workspace::{EditMutation, MutationCommand, WorkspaceMutations};

pub(super) async fn execute(
    owner: &WorkspaceMutations,
    input: CapabilityInvocation<'_>,
) -> Result<Value, CapabilityError> {
    let args = match arguments::parse(input.call) {
        Ok(args) => args,
        Err((error, detail)) => {
            let mut value = failure(
                error,
                "Tool arguments must be a JSON object.",
                "Retry edit_file with one exact edit or canonical edits batch.",
            );
            value["detail"] = json!(detail);
            return Ok(value);
        }
    };
    let has_batch = args.contains_key("edits");
    let has_single = [
        "path",
        "start_line",
        "old_text",
        "new_text",
        "expected_sha256",
    ]
    .into_iter()
    .any(|key| args.contains_key(key));
    if has_batch && has_single {
        return Ok(invalid(
            "Provide exactly one of single edit fields or edits.",
            "Retry with either path/old_text/new_text or edits, never both.",
        ));
    }
    if !has_batch && !has_single {
        return Ok(invalid(
            "Provide exactly one of single edit fields or edits.",
            "Retry with one exact edit or a 2-20 entry edits batch.",
        ));
    }
    let (edits, root) = if has_batch {
        let edits = match normalize::batch(&args["edits"]) {
            Ok(edits) => edits,
            Err(result) => return Ok(result),
        };
        if !arguments::allowed(&input, "edit_file:workspace") {
            return Ok(failure(
                "tool_not_admitted",
                "The edit effect is not admitted for this Steward task.",
                "Use only the exact mutation capability in the delegated packet.",
            ));
        }
        if edits
            .iter()
            .any(|edit| !arguments::scope(&edit.path, input.mutation_scope))
        {
            return Ok(failure(
                "invalid_arguments",
                "The requested path is outside the delegated mutation scope.",
                "Retry only within the immutable Steward mutation scope.",
            ));
        }
        (edits, arguments::root(&input, &args)?)
    } else {
        let edit = match normalize::single(&args) {
            Ok(edit) => edit,
            Err(result) => return Ok(result),
        };
        let root = arguments::root(&input, &args)?;
        if !arguments::scope(&edit.path, input.mutation_scope) {
            return Ok(scope_failure(&root, &edit.path));
        }
        if !arguments::allowed(&input, "edit_file:workspace") {
            return Ok(admission_failure(&root, &edit.path));
        }
        (vec![edit], root)
    };
    let context = arguments::context(&input, root);
    let receiver = owner
        .submit(MutationCommand::Edit(EditMutation {
            context,
            edits,
            batch: has_batch,
        }))
        .map_err(owner_error)?;
    let (outcome, elapsed) = receiver
        .await
        .map_err(|_| CapabilityError {
            code: "workspace_mutation_completion_lost".into(),
        })?
        .map_err(owner_error)?;
    Ok(result::project(outcome, elapsed, has_batch))
}

pub(super) fn failure(error: &str, message: &str, hint: &str) -> Value {
    json!({"ok":false,"error":error,"message":message,"recovery_hint":hint,
        "evidence_capability_receipts":mutation_evidence::failure("edit_file",error,&[],&[],&[],&[])})
}

pub(super) fn invalid(message: impl Into<String>, hint: impl Into<String>) -> Value {
    failure("invalid_arguments", &message.into(), &hint.into())
}

pub(super) fn no_change(message: impl Into<String>) -> Value {
    let mut value = failure("no_change_requested", &message.into(), "");
    value
        .as_object_mut()
        .expect("object")
        .remove("recovery_hint");
    value["changed"] = json!(false);
    value
}

fn scope_failure(root: &std::path::Path, path: &str) -> Value {
    let mut value = failure(
        "invalid_arguments",
        "The requested path is outside the delegated mutation scope.",
        "Retry only within the immutable Steward mutation scope.",
    );
    if let Some(path) = safe_path(root, path) {
        value["path"] = json!(path);
    }
    value
}

fn admission_failure(root: &std::path::Path, path: &str) -> Value {
    let mut value = failure(
        "tool_not_admitted",
        "The edit effect is not admitted for this Steward task.",
        "Use only the exact mutation capability in the delegated packet.",
    );
    if let Some(path) = safe_path(root, path) {
        value["path"] = json!(path);
    }
    value
}

fn safe_path(root: &std::path::Path, path: &str) -> Option<String> {
    let candidate = if std::path::Path::new(path).is_absolute() {
        std::path::Path::new(path)
            .strip_prefix(root)
            .ok()?
            .to_string_lossy()
            .into_owned()
    } else {
        path.to_owned()
    };
    crate::workspace::safe_workspace_path(&candidate).map(str::to_owned)
}

fn owner_error(error: crate::workspace::MutationOwnerError) -> CapabilityError {
    CapabilityError {
        code: error.code.into(),
    }
}
