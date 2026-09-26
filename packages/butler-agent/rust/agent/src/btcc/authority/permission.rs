use serde_json::{Value, json};

use super::contracts::{
    AuthorityAdmissionInput, AuthorityError, AuthorityRecord, AuthorityResult,
    ConversationPermission,
};
use super::identity::{canonical, digest};

pub(super) fn for_admission(
    input: &AuthorityAdmissionInput,
    collation: &crate::locale::LocaleCollation,
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
    collation: &crate::locale::LocaleCollation,
) -> AuthorityResult<ConversationPermission> {
    let input: Value = serde_json::from_str(&record.normalized_input_json)
        .map_err(|_| AuthorityError::policy("authority_request_corrupt"))?;
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
    input: &'a Value,
    title: Option<&'a str>,
    executable: Option<&'a str>,
    collation: &'a crate::locale::LocaleCollation,
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
    let file_edit = matches!(capability, "write_file" | "edit_file");
    let command = matches!(capability, "run_command" | "run_command_remote_observation");
    let scope = if file_edit {
        json!({"kind":"workspace_file_edit"})
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
    let basename = std::path::Path::new(workspace)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    Ok(ConversationPermission {
        grant_ref,
        owner_session_id: owner.to_owned(),
        workspace_path: workspace.to_owned(),
        scope_key,
        title: if file_edit {
            "작업 폴더의 파일 편집".into()
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
        description: if file_edit {
            format!("{basename} 안의 파일 쓰기·수정")
        } else if command {
            format!(
                "{} · 허용한 명령·작업 위치에만 적용",
                executable.unwrap_or("명령")
            )
        } else {
            "허용한 대상·입력에만 적용".into()
        },
        created_at: String::new(),
    })
}
