use crate::public_text::fixed_regex;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::Path,
    sync::OnceLock,
};

use base64::{Engine, engine::general_purpose::STANDARD};
use regex::Regex;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, CognitionResult,
        mutable_paths::ensure_data_authority,
    },
    conversation::{
        ConversationMessageWithParts, ConversationReadOrder, ConversationRole,
        ConversationSourceReader, ReadCognitionMessagesInput, conversation_store_path,
        text_for_message,
    },
};

use super::{
    SCHEMA, hot_cache,
    manifest::{
        self, ContinuityRecoveryManifest, RecoveryBefore, RecoveryCandidate, RecoveryQuarantine,
    },
};

pub(super) fn plan(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    project_id: &str,
    workspace: &Path,
) -> CognitionResult<ContinuityRecoveryManifest> {
    let project_id = crate::public_text::trim_js_whitespace(project_id);
    if project_id.is_empty() {
        return Err(error("continuity_recovery_project_required"));
    }
    let cache = hot_cache::project_cache_path(workspace)?;
    let before_body = hot_cache::read_text(&cache)?;
    let inventory = inventory_canonical_turns(data_root)?;
    let processed_turns = processed_completion_turn_ids(data_root, paths)?;
    let mut candidates = Vec::new();
    let mut quarantine = Vec::new();
    let mut inventory_by_project = BTreeMap::new();
    for turn in inventory {
        let owner = turn.project_id.as_deref().unwrap_or("unscoped");
        *inventory_by_project.entry(owner.to_owned()).or_insert(0) += 1;
        let Some(owner) = turn.project_id.as_deref() else {
            quarantine.push(quarantined(&turn, "missing_project_provenance"));
            continue;
        };
        if owner != project_id || processed_turns.contains(&turn.turn_id) {
            continue;
        }
        match recovery_candidate(&turn) {
            CandidateResult::Ready(candidate) => candidates.push(*candidate),
            CandidateResult::Incomplete => {
                quarantine.push(quarantined(&turn, "incomplete_canonical_turn"));
            }
            CandidateResult::Secret => {
                quarantine.push(quarantined(&turn, "secret_or_credential_risk"));
            }
        }
    }
    candidates.sort_by(|left, right| {
        left.completed_at
            .cmp(&right.completed_at)
            .then_with(|| left.candidate_id.cmp(&right.candidate_id))
    });
    quarantine.sort_by(|left, right| left.conversation_turn_id.cmp(&right.conversation_turn_id));
    let before_hash = sha256(before_body.as_bytes());
    let joined_ids = candidates
        .iter()
        .map(|candidate| candidate.candidate_id.as_str())
        .collect::<Vec<_>>()
        .join("\0");
    let manifest_id = format!(
        "crm_{}",
        &sha256(format!("{project_id}\0{before_hash}\0{joined_ids}").as_bytes())[..32]
    );
    if let Some(existing) = manifest::read(data_root, paths, &manifest_id)? {
        return Ok(existing);
    }
    let now = manifest::now();
    let before = RecoveryBefore {
        path: cache.to_string_lossy().into_owned(),
        bytes: before_body.len(),
        sha256: before_hash,
        body_base64: STANDARD.encode(before_body.as_bytes()),
    };
    let value = ContinuityRecoveryManifest {
        schema_version: SCHEMA.into(),
        manifest_id,
        project_id: project_id.to_owned(),
        status: "dry_run".into(),
        created_at: now.clone(),
        updated_at: now,
        inventory_by_project,
        candidates,
        approved_candidate_ids: Vec::new(),
        quarantine,
        before,
        after: None,
    };
    manifest::write(data_root, paths, &value)?;
    Ok(value)
}

struct CanonicalTurnInventory {
    session_id: String,
    turn_id: String,
    project_id: Option<String>,
    completed_at: String,
    messages: Vec<ConversationMessageWithParts>,
}

fn inventory_canonical_turns(data_root: &Path) -> CognitionResult<Vec<CanonicalTurnInventory>> {
    let path = conversation_store_path(data_root);
    ensure_data_authority(data_root, &[&path])?;
    let reader = ConversationSourceReader::open(&path).map_err(conversation_error)?;
    let result = (|| {
        let mut messages = Vec::new();
        let mut offset = 0usize;
        loop {
            let page = reader
                .read_cognition_messages(&ReadCognitionMessagesInput {
                    roles: vec![ConversationRole::User, ConversationRole::Assistant],
                    limit: Some(1_000.0),
                    offset: Some(offset as f64),
                    include_compacted: true,
                    order: Some(ConversationReadOrder::Asc),
                    ..Default::default()
                })
                .map_err(conversation_error)?;
            let count = page.len();
            messages.extend(page);
            if count < 1_000 {
                break;
            }
            offset += count;
        }
        let mut grouped = HashMap::<String, Vec<ConversationMessageWithParts>>::new();
        for message in messages {
            if let Some(turn_id) = message.message.turn_id.as_deref() {
                grouped.entry(turn_id.to_owned()).or_default().push(message);
            }
        }
        let mut turns = Vec::new();
        for (turn_id, messages) in grouped {
            let Some(turn) = reader.read_turn(&turn_id).map_err(conversation_error)? else {
                continue;
            };
            if turn.status != "complete" {
                continue;
            }
            let session = reader
                .read_session(&turn.session_id)
                .map_err(conversation_error)?;
            turns.push(CanonicalTurnInventory {
                session_id: turn.session_id,
                turn_id,
                project_id: session.and_then(|session| session.project_id),
                completed_at: turn.completed_at.unwrap_or(turn.started_at),
                messages,
            });
        }
        Ok(turns)
    })();
    let closed = reader.close().map_err(conversation_error);
    match (result, closed) {
        (Err(failure), _) | (Ok(_), Err(failure)) => Err(failure),
        (Ok(turns), Ok(())) => Ok(turns),
    }
}

fn processed_completion_turn_ids(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
) -> CognitionResult<HashSet<String>> {
    let root = paths.memory_root(data_root).join("queue");
    let observations = root.join("completion-observations");
    let receipts = root.join("completion-receipts");
    ensure_data_authority(data_root, &[&root, &observations, &receipts])?;
    if !observations.exists() || !receipts.exists() {
        return Ok(HashSet::new());
    }
    let files = fs::read_dir(&observations)
        .map_err(|_| error("continuity_recovery_inventory_read_failed"))?;
    let mut turns = HashSet::new();
    for file in files {
        let path = file
            .map_err(|_| error("continuity_recovery_inventory_read_failed"))?
            .path();
        ensure_data_authority(data_root, &[&path])?;
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(observation) = serde_json::from_str::<Value>(&content) else {
            continue;
        };
        let Some(job_id) = observation.get("job_id").and_then(Value::as_str) else {
            continue;
        };
        let receipt = receipts.join(format!("{}.json", manifest::safe_id(job_id)));
        ensure_data_authority(data_root, &[&receipt])?;
        if receipt.exists()
            && let Some(turn_id) = observation
                .get("conversation_turn_id")
                .and_then(Value::as_str)
        {
            turns.insert(turn_id.to_owned());
        }
    }
    Ok(turns)
}

enum CandidateResult {
    Ready(Box<RecoveryCandidate>),
    Incomplete,
    Secret,
}

fn recovery_candidate(turn: &CanonicalTurnInventory) -> CandidateResult {
    let user = turn
        .messages
        .iter()
        .find(|message| message.message.role == ConversationRole::User);
    let assistant = turn
        .messages
        .iter()
        .rev()
        .find(|message| message.message.role == ConversationRole::Assistant);
    let (Some(user), Some(assistant)) = (user, assistant) else {
        return CandidateResult::Incomplete;
    };
    let user_text = compact(&text_for_message(user, false), 280);
    let assistant_text = compact(&text_for_message(assistant, false), 360);
    if user_text.is_empty() || assistant_text.is_empty() {
        return CandidateResult::Incomplete;
    }
    let body = format!(
        "**Recovered Turn**\n- User objective: {user_text}\n- Assistant outcome: {assistant_text}\n- Provenance: conversation={}; turn={}; inbound={}; outbound={}",
        turn.session_id, turn.turn_id, user.message.id, assistant.message.id
    );
    if contains_secret(&body) {
        return CandidateResult::Secret;
    }
    let seed = format!(
        "{}\0{}\0{}",
        turn.turn_id, user.message.id, assistant.message.id
    );
    let candidate_id = format!("crc_{}", &sha256(seed.as_bytes())[..24]);
    CandidateResult::Ready(Box::new(RecoveryCandidate {
        candidate_id,
        project_id: turn.project_id.clone().unwrap_or_default(),
        conversation_session_id: turn.session_id.clone(),
        conversation_turn_id: turn.turn_id.clone(),
        inbound_message_id: user.message.id.clone(),
        outbound_message_id: assistant.message.id.clone(),
        completed_at: turn.completed_at.clone(),
        preview: compact(&format!("{user_text} -> {assistant_text}"), 240),
        body_sha256: sha256(body.as_bytes()),
        body,
    }))
}

fn quarantined(turn: &CanonicalTurnInventory, reason: &str) -> RecoveryQuarantine {
    RecoveryQuarantine {
        conversation_session_id: turn.session_id.clone(),
        conversation_turn_id: turn.turn_id.clone(),
        reason: reason.into(),
    }
}

fn compact(value: &str, max: usize) -> String {
    let mut normalized = String::new();
    let mut pending_space = false;
    for character in value.chars() {
        if crate::public_text::is_js_whitespace(character) {
            pending_space = !normalized.is_empty();
        } else {
            if pending_space {
                normalized.push(' ');
                pending_space = false;
            }
            normalized.push(character);
        }
    }
    let units = normalized.encode_utf16().collect::<Vec<_>>();
    if units.len() <= max {
        return normalized;
    }
    let prefix = String::from_utf16_lossy(&units[..max.saturating_sub(3)]);
    format!("{prefix}...")
}

fn contains_secret(value: &str) -> bool {
    static SECRET: OnceLock<Regex> = OnceLock::new();
    SECRET
        .get_or_init(|| {
            fixed_regex(r"(?i)-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b|\bAKIA[0-9A-Z]{16}\b|\b(?:password|passwd|token|api[_ -]?key)\s*[:=]\s*[^\s]{8,}")
        })
        .is_match(value)
}

fn sha256(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

fn conversation_error(error: crate::conversation::ConversationError) -> CognitionError {
    CognitionError::new("continuity_recovery_inventory_read_failed", error.message)
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
