use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::contracts::{AuthorityAdmissionInput, AuthorityError, AuthorityResult};

pub(super) fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
pub(super) fn canonical(
    value: &Value,
    collation: &crate::locale::LocaleCollation,
) -> AuthorityResult<String> {
    crate::json::stringify_sorted(value, &|a, b| collation.compare(a, b)).map_err(|error| {
        AuthorityError::policy(format!("authority_json: {error}")).with_source(error)
    })
}
pub(super) fn identity(
    input: &AuthorityAdmissionInput,
    generation: i64,
    collation: &crate::locale::LocaleCollation,
) -> AuthorityResult<String> {
    let mut object = Map::new();
    object.insert("version".into(), json!(1));
    for (key, value) in [
        ("ownerSessionId", &input.owner_session_id),
        ("sourceSessionId", &input.source_session_id),
        ("sourceTurnId", &input.source_turn_id),
        ("sourceWorkId", &input.source_work_id),
        ("workspacePath", &input.workspace_path),
        ("planRevisionId", &input.plan_revision_id),
        ("actionKey", &input.action_key),
    ] {
        object.insert(key.into(), json!(value));
    }
    object.insert("authorityGeneration".into(), json!(generation));
    object.insert("capability".into(), json!(input.capability));
    object.insert("target".into(), json!(input.target));
    object.insert("normalizedInput".into(), input.normalized_input.clone());
    if let Some(occurrence) = input
        .operation_occurrence_id
        .as_deref()
        .filter(|s| !s.is_empty())
    {
        object.insert("operationOccurrenceId".into(), json!(occurrence));
    }
    if input.category.as_deref() == Some("reviewed_effect") {
        object.insert("version".into(), json!(2));
        object.insert("category".into(), json!("reviewed_effect"));
        object.insert(
            "operationOccurrenceId".into(),
            json!(required(
                input.operation_occurrence_id.as_deref().unwrap_or(""),
                "operation occurrence",
            )?),
        );
    }
    Ok(digest(&canonical(&Value::Object(object), collation)?))
}
pub(super) fn client_message_id(request_id: &str) -> String {
    let hash = digest(&format!("authority-queue\0{request_id}"));
    format!(
        "client-{}-{}-4{}-8{}-{}",
        &hash[..8],
        &hash[8..12],
        &hash[13..16],
        &hash[17..20],
        &hash[20..32]
    )
}
pub(super) fn required<'a>(value: &'a str, label: &str) -> AuthorityResult<&'a str> {
    if crate::public_text::trim_js_whitespace(value).is_empty() {
        Err(AuthorityError::policy(format!(
            "authority_{}_missing",
            label.replace(' ', "_")
        )))
    } else {
        Ok(value)
    }
}
pub(super) fn slice_utf16(value: &str, units: usize) -> String {
    let mut output = String::new();
    let mut used = 0;
    for character in value.chars() {
        if used + character.len_utf16() > units {
            if used < units {
                // This output is persisted as Bun SQLite TEXT. At the source
                // 96-unit boundary, an isolated high surrogate round-trips
                // as three replacement characters on row hydration.
                output.push_str("\u{fffd}\u{fffd}\u{fffd}");
            }
            break;
        }
        output.push(character);
        used += character.len_utf16();
    }
    output
}
