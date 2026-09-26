use super::contracts::{
    AuthorityAdmissionInput, AuthorityAdmissionResult, AuthorityError, AuthorityRecord,
    AuthorityRepository, AuthorityResult,
};
use super::{identity, permission, projection};

const ALLOW_TEXT: &str = "Continue the approved operation exactly once.";

pub(super) fn admit(
    repository: &mut dyn AuthorityRepository,
    input: AuthorityAdmissionInput,
    collation: &crate::locale::LocaleCollation,
    clock: &dyn Fn() -> String,
    uuid: &dyn Fn() -> String,
) -> AuthorityResult<AuthorityAdmissionResult> {
    let mut generation = input.authority_generation;
    let identity_sha = loop {
        let sha = identity::identity(&input, generation, collation)?;
        if let Some(existing) = repository.find_identity(&sha)? {
            assert_not_closed(&existing)?;
            return projection::admission(&existing, collation);
        }
        if repository.has_permission(&permission::for_admission(&input, collation)?.grant_ref)? {
            return Ok(AuthorityAdmissionResult::Granted);
        }
        match repository.find_slot(&input, generation)? {
            None => break sha,
            Some(slot) if terminal(&slot) => {
                generation += 1;
            }
            Some(_) => return Err(AuthorityError::policy("authority_slot_identity_mismatch")),
        }
    };
    let now = clock();
    let request_id = format!("authority-{}", uuid());
    let request_ref = format!(
        "authority-ref-{}",
        &identity::digest(&format!("{request_id}\0{identity_sha}"))[..32]
    );
    let reviewed = input.category.as_deref() == Some("reviewed_effect");
    let category = if reviewed {
        "reviewed_effect"
    } else {
        "command"
    };
    let required = |value: &str, label: &str| identity::required(value, label).map(str::to_owned);
    let record = AuthorityRecord {
        request_id: request_id.clone(),
        request_ref,
        identity_sha256: identity_sha.clone(),
        owner_session_id: required(&input.owner_session_id, "owner session")?,
        source_session_id: required(&input.source_session_id, "source session")?,
        source_turn_id: required(&input.source_turn_id, "source Turn")?,
        source_call_id: input
            .operation_occurrence_id
            .filter(|value| !value.is_empty()),
        source_work_id: required(&input.source_work_id, "source Work")?,
        workspace_path: required(&input.workspace_path, "workspace")?,
        plan_revision_id: required(&input.plan_revision_id, "Plan revision")?,
        action_key: required(&input.action_key, "action")?,
        authority_generation: generation,
        capability: required(&input.capability, "capability")?,
        normalized_target: required(&input.target, "target")?,
        normalized_input_json: identity::canonical(&input.normalized_input, collation)?,
        model_ref: required(&input.model_ref, "model")?,
        reasoning_effort: required(&input.reasoning_effort, "reasoning effort")?,
        category: category.into(),
        reason: input
            .public_action_title
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| {
                if reviewed {
                    "Apply one reviewed effect"
                } else {
                    "Run one reviewed command"
                }
                .into()
            }),
        executable: if reviewed {
            identity::slice_utf16(identity::required(&input.capability, "capability")?, 96)
        } else {
            first_executable(
                input
                    .normalized_input
                    .get("command")
                    .and_then(|value| value.as_str())
                    .unwrap_or(""),
            )
        },
        command_count: 1,
        decision: "pending".into(),
        allow_scope: "once".into(),
        schedule_client_message_id: identity::client_message_id(&request_id),
        schedule_input_text: ALLOW_TEXT.into(),
        private_alternative_input: None,
        outcome: "pending".into(),
        outcome_receipt_json: None,
        close_reason: None,
        close_scope: None,
        closed_at: None,
        created_at: now.clone(),
        updated_at: now,
    };
    repository.insert(&record)?;
    let stored = repository
        .find_identity(&identity_sha)?
        .ok_or_else(|| AuthorityError::policy("authority_request_insert_conflict"))?;
    if stored.identity_sha256 != identity_sha {
        return Err(AuthorityError::policy("authority_request_insert_conflict"));
    }
    assert_not_closed(&stored)?;
    projection::admission(&stored, collation)
}
fn terminal(record: &AuthorityRecord) -> bool {
    record.close_reason.is_some()
        || matches!(record.decision.as_str(), "denied" | "modified")
        || record.outcome != "pending"
}
fn assert_not_closed(record: &AuthorityRecord) -> AuthorityResult<()> {
    if record.decision == "pending" && record.close_reason.is_some() {
        Err(AuthorityError::policy(
            "authority_request_operationally_closed",
        ))
    } else {
        Ok(())
    }
}

pub(super) fn first_executable(command: &str) -> String {
    let Some(tokens) = shell_words(command) else {
        return "command".into();
    };
    let mut words = tokens.iter();
    let candidate = loop {
        let Some(word) = words.next() else {
            return "command".into();
        };
        let assignment = word.split_once('=').is_some_and(|(name, _)| {
            let mut chars = name.chars();
            chars
                .next()
                .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
                && chars.all(|part| part.is_ascii_alphanumeric() || part == '_')
        });
        if !assignment {
            break word;
        }
    };
    if candidate.is_empty()
        || candidate.starts_with(['$', '-'])
        || !candidate
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'/' | b'-'))
    {
        return "command".into();
    }
    let executable = candidate.rsplit(['/', '\\']).next().unwrap_or("");
    let executable = crate::public_text::trim_js_whitespace(executable);
    if executable.is_empty() {
        "command".into()
    } else {
        identity::slice_utf16(executable, 96)
    }
}
fn shell_words(command: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    let mut started = false;
    for character in crate::public_text::trim_js_whitespace(command).chars() {
        if escaped {
            word.push(character);
            escaped = false;
            started = true;
            continue;
        }
        if character == '\\' && quote != Some('\'') {
            escaped = true;
            started = true;
            continue;
        }
        if let Some(mark) = quote {
            if character == mark {
                quote = None;
            } else {
                word.push(character);
            }
            started = true;
            continue;
        }
        if character == '\'' || character == '"' {
            quote = Some(character);
            started = true;
            continue;
        }
        if crate::public_text::is_js_whitespace(character) {
            if started {
                words.push(std::mem::take(&mut word));
                started = false;
            }
            continue;
        }
        word.push(character);
        started = true;
    }
    if escaped || quote.is_some() {
        return None;
    }
    if started {
        words.push(word);
    }
    Some(words)
}
