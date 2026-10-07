use serde_json::{Value, json};

use super::contracts::{
    AuthorityAdmissionInput, AuthorityError, AuthorityRecord, AuthorityResult,
    ConversationPermission, PermissionSource, PermissionTarget,
};
use super::identity::{canonical, digest};
use butler_core::tool_protocol::ToolName;
mod command_scope;
mod command_source;
pub(super) use command_scope::CommandScope;

pub(super) fn for_admission(
    input: &AuthorityAdmissionInput,
    collation: &butler_core::locale::LocaleCollation,
) -> AuthorityResult<ConversationPermission> {
    permission(PermissionFacts {
        owner: &input.owner_session_id,
        workspace: &input.workspace_path,
        capability: &input.capability,
        target: &input.target,
        input: &input.normalized_input,
        title: input.public_action_title.as_deref(),
        executable: None,
        collation,
    })
}
pub(super) fn for_record(
    record: &AuthorityRecord,
    collation: &butler_core::locale::LocaleCollation,
) -> AuthorityResult<ConversationPermission> {
    let input: Value = serde_json::from_str(&record.normalized_input_json).map_err(|source| {
        AuthorityError::policy("authority_request_corrupt").with_source(source)
    })?;
    let title = if matches!(
        record.reason.as_str(),
        "Run one reviewed command" | "Apply one reviewed effect"
    ) {
        None
    } else {
        Some(record.reason.as_str())
    };
    permission(PermissionFacts {
        owner: &record.owner_session_id,
        workspace: &record.workspace_path,
        capability: &record.capability,
        target: &record.normalized_target,
        input: &input,
        title,
        executable: Some(&record.executable),
        collation,
    })
}

#[derive(Clone, Copy)]
struct PermissionFacts<'a> {
    owner: &'a str,
    workspace: &'a str,
    capability: &'a str,
    target: &'a str,
    // Passthrough: tool arguments/results/schemas, shaped by each tool.
    input: &'a Value,
    title: Option<&'a str>,
    executable: Option<&'a str>,
    collation: &'a butler_core::locale::LocaleCollation,
}

fn permission(facts: PermissionFacts<'_>) -> AuthorityResult<ConversationPermission> {
    let PermissionFacts {
        owner,
        workspace,
        capability,
        target: _,
        input,
        title,
        executable,
        collation: _,
    } = facts;
    let file_edit = matches!(
        ToolName::parse(capability),
        Some(ToolName::WriteFile | ToolName::EditFile)
    );
    let command = matches!(capability, "run_command" | "run_command_remote_observation");
    let (scope_key, grant_ref) = permission_identity(facts, file_edit, command)?;
    Ok(ConversationPermission {
        capability: capability.into(),
        target: butler_core::public_text::sanitize_public_delta(&permission_target(facts, command)),
        cwd: command.then(|| {
            input
                .get("cwd")
                .and_then(Value::as_str)
                .unwrap_or(workspace)
                .to_owned()
        }),
        grant_ref,
        owner_session_id: owner.to_owned(),
        workspace_path: workspace.to_owned(),
        scope_key,
        title: if file_edit {
            "동일한 파일 작업".into()
        } else {
            title
                .filter(|value| !value.is_empty())
                .unwrap_or(if command {
                    "동일한 명령 실행"
                } else {
                    "동일한 작업 실행"
                })
                .into()
        },
        description: permission_description(file_edit, command, executable),
        created_at: String::new(),
    })
}

fn permission_scope_key(
    facts: PermissionFacts<'_>,
    file_edit: bool,
    command: bool,
) -> AuthorityResult<String> {
    scope_key(
        std::borrow::Cow::Borrowed(facts.input),
        facts.capability,
        facts.target,
        facts.collation,
        file_edit,
        command,
    )
}

fn scope_key(
    mut input: std::borrow::Cow<'_, Value>,
    capability: &str,
    target: &str,
    collation: &butler_core::locale::LocaleCollation,
    file_edit: bool,
    command: bool,
) -> AuthorityResult<String> {
    let mut scope = serde_json::Map::new();
    scope.insert(
        "kind".into(),
        json!(if file_edit {
            "file_operation"
        } else if command {
            "command"
        } else {
            "effect"
        }),
    );
    if command {
        for (name, source) in [
            ("command", "command"),
            ("cwd", "cwd"),
            ("stateEffect", "state_effect"),
        ] {
            // Listing owns the decoded JSON: move its scope fields instead of
            // cloning the same command/cwd (or arbitrarily large effect input).
            let value = match &mut input {
                std::borrow::Cow::Borrowed(input) => input.get(source).cloned(),
                std::borrow::Cow::Owned(input) => input
                    .as_object_mut()
                    .and_then(|object| object.remove(source)),
            };
            if let Some(value) = value {
                scope.insert(name.into(), value);
            }
        }
    } else {
        scope.insert("capability".into(), json!(capability));
        scope.insert("target".into(), json!(target));
        scope.insert("input".into(), input.into_owned());
    }
    Ok(digest(&canonical(&Value::Object(scope), collation)?))
}

fn permission_identity(
    facts: PermissionFacts<'_>,
    file_edit: bool,
    command: bool,
) -> AuthorityResult<(String, String)> {
    let PermissionFacts {
        owner,
        workspace,
        collation,
        ..
    } = facts;
    let scope_key = permission_scope_key(facts, file_edit, command)?;
    let grant_ref = format!(
        "permission-{}",
        &digest(&canonical(
            &json!([owner, workspace, scope_key]),
            collation
        )?)[..32]
    );
    Ok((scope_key, grant_ref))
}

pub(super) fn for_source(
    source: &PermissionSource<'_>,
    collation: &butler_core::locale::LocaleCollation,
    prefixes: &mut std::collections::HashMap<String, std::collections::HashMap<String, String>>,
    command_scope: &CommandScope,
) -> AuthorityResult<PermissionTarget> {
    if matches!(
        source.capability,
        "run_command" | "run_command_remote_observation"
    ) && let Some(target) = command_source::project(source, collation, prefixes, command_scope)?
    {
        return Ok(target);
    }
    let input: Value = serde_json::from_str(source.input_json)
        .map_err(|error| AuthorityError::policy("authority_request_corrupt").with_source(error))?;
    for_decoded_source(source, collation, prefixes, command_scope, input)
}

fn for_decoded_source(
    source: &PermissionSource<'_>,
    collation: &butler_core::locale::LocaleCollation,
    prefixes: &mut std::collections::HashMap<String, std::collections::HashMap<String, String>>,
    command_scope: &CommandScope,
    input: Value,
) -> AuthorityResult<PermissionTarget> {
    let facts = PermissionFacts {
        owner: source.owner,
        workspace: source.workspace,
        capability: source.capability,
        target: source.target,
        input: &input,
        title: None,
        executable: None,
        collation,
    };
    let file_edit = matches!(
        ToolName::parse(source.capability),
        Some(ToolName::WriteFile | ToolName::EditFile)
    );
    let command = matches!(
        source.capability,
        "run_command" | "run_command_remote_observation"
    );
    let target =
        butler_core::public_text::sanitize_public_delta(&permission_target(facts, command));
    let cwd = command.then(|| {
        input
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or(source.workspace)
            .to_owned()
    });
    let scope_key = if command {
        command_scope.key(&input, collation)?
    } else {
        scope_key(
            std::borrow::Cow::Owned(input),
            source.capability,
            source.target,
            collation,
            file_edit,
            command,
        )?
    };
    let grant_ref = source_grant_ref(source, &scope_key, collation, prefixes)?;
    Ok(PermissionTarget {
        grant_ref,
        capability: source.capability.to_owned(),
        target,
        cwd,
    })
}

fn source_grant_ref(
    source: &PermissionSource<'_>,
    scope_key: &str,
    collation: &butler_core::locale::LocaleCollation,
    prefixes: &mut std::collections::HashMap<String, std::collections::HashMap<String, String>>,
) -> AuthorityResult<String> {
    if !prefixes
        .get(source.owner)
        .is_some_and(|paths| paths.contains_key(source.workspace))
    {
        let mut prefix = canonical(&json!([source.owner, source.workspace]), collation)?;
        let _ = prefix.pop();
        prefixes
            .entry(source.owner.to_owned())
            .or_default()
            .insert(source.workspace.to_owned(), prefix);
    }
    let prefix = prefixes
        .get(source.owner)
        .and_then(|paths| paths.get(source.workspace))
        .ok_or_else(|| AuthorityError::policy("authority_request_corrupt"))?;
    Ok(format!(
        "permission-{}",
        &digest(&format!("{prefix},\"{scope_key}\"]"))[..32]
    ))
}

fn permission_description(file_edit: bool, command: bool, executable: Option<&str>) -> String {
    if file_edit {
        "허용한 경로·입력에만 적용".into()
    } else if command {
        format!(
            "{} · 허용한 명령·작업 위치에만 적용",
            executable.unwrap_or("명령")
        )
    } else {
        "허용한 대상·입력에만 적용".into()
    }
}

fn permission_target(facts: PermissionFacts<'_>, command: bool) -> String {
    let keys: &[&str] = if command {
        &["command"]
    } else {
        &["path", "directory", "root"]
    };
    for key in keys {
        if let Some(value) = facts.input.get(key).and_then(Value::as_str) {
            return value.into();
        }
    }
    for key in ["requests", "edits"] {
        if let Some(items) = facts.input.get(key).and_then(Value::as_array) {
            let paths = items
                .iter()
                .filter_map(|item| item.get("path").and_then(Value::as_str))
                .collect::<Vec<_>>();
            if !paths.is_empty() {
                return paths.join("\n");
            }
        }
    }
    if facts.target.starts_with("observation:") {
        facts.workspace.into()
    } else {
        facts.target.into()
    }
}
