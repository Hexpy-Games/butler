use serde_json::{Value, json};

use super::contracts::{
    AuthorityAdmissionInput, AuthorityError, AuthorityRecord, AuthorityResult,
    ConversationPermission,
};
use super::identity::{canonical, digest};
use butler_core::tool_protocol::ToolName;

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
        target,
        input,
        title,
        executable,
        collation,
    } = facts;
    let file_edit = matches!(
        ToolName::parse(capability),
        Some(ToolName::WriteFile | ToolName::EditFile)
    );
    let command = matches!(capability, "run_command" | "run_command_remote_observation");
    let scope = if file_edit {
        json!({"kind":"file_operation","capability":capability,"target":target,"input":input})
    } else if command {
        let mut scope = serde_json::Map::new();
        scope.insert("kind".into(), json!("command"));
        for (name, source) in [
            ("command", "command"),
            ("cwd", "cwd"),
            ("stateEffect", "state_effect"),
        ] {
            if let Some(value) = input.get(source) {
                scope.insert(name.into(), value.clone());
            }
        }
        Value::Object(scope)
    } else {
        json!({"kind":"effect","capability":capability,"target":target,"input":input})
    };
    let scope_key = digest(&canonical(&scope, collation)?);
    let grant_ref = format!(
        "permission-{}",
        &digest(&canonical(
            &json!([owner, workspace, scope_key]),
            collation
        )?)[..32]
    );
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
