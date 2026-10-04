use super::contracts::{
    AuthorityAdmissionInput, AuthorityAdmissionResult, AuthorityError, AuthorityRecord,
    AuthorityRepository, AuthorityResult, RequestDecision, RequestOutcome,
};
use super::{identity, permission, projection};

const ALLOW_TEXT: &str = "Continue the approved operation exactly once.";

/// Admits an authority request for a reviewed operation: replays an existing
/// request of the same identity, reports a standing permission, or inserts a
/// new pending request in the first free generation slot.
pub(super) fn admit(
    repository: &mut dyn AuthorityRepository,
    input: AuthorityAdmissionInput,
    collation: &butler_core::locale::LocaleCollation,
    clock: &dyn Fn() -> String,
    uuid: &dyn Fn() -> String,
) -> AuthorityResult<AuthorityAdmissionResult> {
    let (identity_sha, generation) = match free_slot(repository, &input, collation)? {
        Slot::Settled(result) => return Ok(*result),
        Slot::Free {
            identity_sha,
            generation,
        } => (identity_sha, generation),
    };
    let now = clock();
    let record = pending_record(
        input,
        PendingIdentity {
            identity_sha: identity_sha.clone(),
            generation,
            request_id: format!("authority-{}", uuid()),
            now,
        },
        collation,
    )?;
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

/// The admission slot of a request.
enum Slot {
    /// An existing request or a standing permission already answers it.
    Settled(Box<AuthorityAdmissionResult>),
    /// No request holds this identity and generation yet.
    Free {
        identity_sha: String,
        generation: i64,
    },
}

/// Walks generations past terminal requests to the first free slot.
fn free_slot(
    repository: &mut dyn AuthorityRepository,
    input: &AuthorityAdmissionInput,
    collation: &butler_core::locale::LocaleCollation,
) -> AuthorityResult<Slot> {
    let mut generation = input.authority_generation;
    loop {
        let sha = identity::identity(input, generation, collation)?;
        if let Some(existing) = repository.find_identity(&sha)? {
            assert_not_closed(&existing)?;
            return projection::admission(&existing, collation)
                .map(|result| Slot::Settled(Box::new(result)));
        }
        if repository.has_permission(&permission::for_admission(input, collation)?.grant_ref)? {
            return Ok(Slot::Settled(Box::new(AuthorityAdmissionResult::Granted)));
        }
        match repository.find_slot(input, generation)? {
            None => {
                return Ok(Slot::Free {
                    identity_sha: sha,
                    generation,
                });
            }
            Some(slot) if terminal(&slot) => generation += 1,
            Some(_) => return Err(AuthorityError::policy("authority_slot_identity_mismatch")),
        }
    }
}

/// The identity of a new request.
struct PendingIdentity {
    identity_sha: String,
    generation: i64,
    request_id: String,
    now: String,
}

/// The pending, allow-once request record of a reviewed effect or command.
fn pending_record(
    input: AuthorityAdmissionInput,
    pending: PendingIdentity,
    collation: &butler_core::locale::LocaleCollation,
) -> AuthorityResult<AuthorityRecord> {
    let PendingIdentity {
        identity_sha,
        generation,
        request_id,
        now,
    } = pending;
    let digest = identity::digest(&format!("{request_id}\0{identity_sha}"));
    let request_ref = format!(
        "authority-ref-{}",
        digest.get(..32).unwrap_or(digest.as_str())
    );
    let category = Category::of(&input);
    // Evaluated early for borrowing; its error surfaces in field order below.
    let executable = category.executable(&input);
    let required = |value: &str, label: &str| identity::required(value, label).map(str::to_owned);
    Ok(AuthorityRecord {
        request_id: request_id.clone(),
        request_ref,
        identity_sha256: identity_sha,
        owner_session_id: required(&input.owner_session_id, "owner session")?,
        source_session_id: required(&input.source_session_id, "source session")?,
        source_turn_id: required(&input.source_turn_id, "source Turn")?,
        source_call_id: input
            .operation_occurrence_id
            .filter(|value| !value.is_empty()),
        source_work_id: if category == Category::Observation {
            input.source_work_id
        } else {
            required(&input.source_work_id, "source Work")?
        },
        workspace_path: required(&input.workspace_path, "workspace")?,
        plan_revision_id: if category == Category::Observation {
            input.plan_revision_id
        } else {
            required(&input.plan_revision_id, "Plan revision")?
        },
        action_key: required(&input.action_key, "action")?,
        authority_generation: generation,
        capability: required(&input.capability, "capability")?,
        normalized_target: required(&input.target, "target")?,
        normalized_input_json: identity::canonical(&input.normalized_input, collation)?,
        model_ref: required(&input.model_ref, "model")?,
        reasoning_effort: required(&input.reasoning_effort, "reasoning effort")?,
        category: category.as_str().into(),
        reason: input
            .public_action_title
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| category.default_reason().into()),
        executable: executable?,
        command_count: 1,
        decision: RequestDecision::Pending,
        allow_scope: "once".into(),
        schedule_client_message_id: identity::client_message_id(&request_id),
        schedule_input_text: ALLOW_TEXT.into(),
        private_alternative_input: None,
        outcome: RequestOutcome::Pending,
        outcome_receipt_json: None,
        close_reason: None,
        close_scope: None,
        closed_at: None,
        created_at: now.clone(),
        updated_at: now,
    })
}

/// What an authority request approves: one reviewed effect or one command.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Category {
    ReviewedEffect,
    Observation,
    Command,
}

impl Category {
    fn of(input: &AuthorityAdmissionInput) -> Self {
        if (input.category.as_deref() == Some("command_observation")
            && input.capability == "run_command"
            && matches!(
                input.normalized_input.get("state_effect").and_then(serde_json::Value::as_str),
                Some("read_only" | "validation")
            ))
            || (input.category.as_deref() == Some("file_observation")
                && matches!(
                    input.capability.as_str(),
                    "list_files" | "read_file" | "grep_files"
                ))
        {
            Self::Observation
        } else if input.category.as_deref() == Some("reviewed_effect") {
            Self::ReviewedEffect
        } else {
            Self::Command
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            // Preserve the deployed CHECK; capability identifies the observation subtype.
            Self::ReviewedEffect | Self::Observation => "reviewed_effect",
            Self::Command => "command",
        }
    }

    fn default_reason(self) -> &'static str {
        match self {
            Self::ReviewedEffect => "Apply one reviewed effect",
            Self::Observation => "Read files",
            Self::Command => "Run one reviewed command",
        }
    }

    /// The reviewed capability, or the command's first executable.
    fn executable(self, input: &AuthorityAdmissionInput) -> AuthorityResult<String> {
        Ok(match self {
            Self::ReviewedEffect | Self::Observation => {
                identity::slice_utf16(identity::required(&input.capability, "capability")?, 96)
            }
            Self::Command => first_executable(
                input
                    .normalized_input
                    .get("command")
                    .and_then(|value| value.as_str())
                    .unwrap_or(""),
            ),
        })
    }
}

fn terminal(record: &AuthorityRecord) -> bool {
    record.close_reason.is_some()
        || matches!(
            record.decision,
            RequestDecision::Denied | RequestDecision::Modified
        )
        || record.outcome != RequestOutcome::Pending
}
fn assert_not_closed(record: &AuthorityRecord) -> AuthorityResult<()> {
    if record.decision == RequestDecision::Pending && record.close_reason.is_some() {
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
    let executable = butler_core::public_text::trim_js_whitespace(executable);
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
    for character in butler_core::public_text::trim_js_whitespace(command).chars() {
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
        if butler_core::public_text::is_js_whitespace(character) {
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
