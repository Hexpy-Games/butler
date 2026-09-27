use sha2::{Digest, Sha256};

use super::super::conversation_session_id_for_durable_session;
use super::classifier::Decision;

pub(super) fn target_session(decision: &Decision) -> String {
    decision
        .conversation_session_id
        .clone()
        .unwrap_or_else(|| conversation_session_id_for_durable_session(&decision.session_id))
}

pub(super) fn target_message_id(decision: &Decision) -> String {
    decision
        .conversation_message_id
        .clone()
        .unwrap_or_else(|| recovered_id("cm", &recovery_source_ref(decision)))
}

pub(super) fn recovery_source_ref(decision: &Decision) -> String {
    historical_source_ref(
        decision.kind.text(),
        &decision.session_id,
        &decision.source_id,
    )
}

pub(crate) fn historical_source_ref(kind: &str, session_id: &str, source_id: &str) -> String {
    format!(
        "recovery:{kind}:{}",
        hash_parts(&[kind, session_id, source_id])
    )
}

pub(super) fn app_session_id(chat_id: &str) -> String {
    let chat_id = chat_id.trim();
    if chat_id == "general" {
        return "butler/app-general".into();
    }
    let chat_id = if chat_id.is_empty() {
        "unknown"
    } else {
        chat_id
    };
    let mut segment = String::new();
    let mut replacing = false;
    for ch in chat_id.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            segment.push(ch);
            replacing = false;
        } else if !replacing {
            segment.push('-');
            replacing = true;
        }
    }
    if segment.is_empty() {
        segment.push_str("session");
    }
    format!("butler/app-{segment}")
}

pub(super) fn valid_timestamp(value: &str, parse_timestamp: &dyn Fn(&str) -> Option<i64>) -> bool {
    timestamp_millis(value, parse_timestamp).is_some()
}

pub(super) fn timestamp_millis(
    value: &str,
    parse_timestamp: &dyn Fn(&str) -> Option<i64>,
) -> Option<i64> {
    parse_timestamp(value)
}

pub(super) fn clean(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

pub(super) fn clean_opt(value: Option<&str>) -> Option<String> {
    value.and_then(clean)
}

pub(super) fn redacted(scope: &str, value: &str) -> String {
    format!("{scope}:{}", &hash_parts(&[scope, value])[..16])
}

fn hash_parts(parts: &[&str]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update(part.as_bytes());
        hash.update([0]);
    }
    format!("{:x}", hash.finalize())[..32].into()
}

pub(super) fn recovered_id(prefix: &str, value: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(value.as_bytes()));
    format!("{prefix}_recovered_{}", &digest[..32])
}
