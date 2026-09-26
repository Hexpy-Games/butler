//! Exact inbound-queue terminal fencing for claim-bearing final outbounds.

use std::path::Path;

use serde_json::Value;

use super::TranscriptEvent;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Disposition {
    Accept,
    Defer,
    Reject,
}

pub(super) fn disposition(root: &Path, event: &TranscriptEvent) -> Disposition {
    let metadata = event.payload.get("metadata").and_then(Value::as_object);
    let Some(metadata) = metadata else {
        return Disposition::Accept;
    };
    let Some(queue_id) = metadata.get("queueId").and_then(safe_queue_id) else {
        return Disposition::Accept;
    };
    let Some(dispatch_claim) = metadata.get("dispatchClaimId").and_then(safe_token) else {
        return Disposition::Accept;
    };
    if let Some(failed) = read(root, "failed", &queue_id) {
        return if recoverable_failure(metadata, &failed, &dispatch_claim) {
            Disposition::Accept
        } else {
            Disposition::Reject
        };
    }
    let Some(processed) = read(root, "processed", &queue_id) else {
        return Disposition::Defer;
    };
    let Some(terminal_claim) = terminal_claim(&processed) else {
        return Disposition::Defer;
    };
    if terminal_claim == dispatch_claim {
        Disposition::Accept
    } else {
        Disposition::Reject
    }
}

pub(super) fn verified_processed_claim(root: &Path, event: &TranscriptEvent) -> bool {
    let Some(metadata) = event.payload.get("metadata").and_then(Value::as_object) else {
        return false;
    };
    if metadata
        .get("appQueueClaimProvenance")
        .and_then(Value::as_str)
        != Some("matching_app_target")
    {
        return false;
    }
    let Some(queue_id) = metadata.get("queueId").and_then(safe_queue_id) else {
        return false;
    };
    let Some(dispatch_claim) = metadata.get("dispatchClaimId").and_then(safe_token) else {
        return false;
    };
    if read(root, "failed", &queue_id).is_some() {
        return false;
    }
    read(root, "processed", &queue_id)
        .and_then(|value| terminal_claim(&value))
        .as_deref()
        == Some(dispatch_claim.as_str())
}

fn recoverable_failure(
    metadata: &serde_json::Map<String, Value>,
    failed: &Value,
    dispatch_claim: &str,
) -> bool {
    if terminal_claim(failed).as_deref() != Some(dispatch_claim) {
        return false;
    }
    let failure_code = failed
        .get("metadata")
        .and_then(Value::as_object)
        .and_then(|value| value.get("failure"))
        .and_then(Value::as_object)
        .and_then(|value| value.get("code"))
        .and_then(safe_token);
    if !matches!(
        failure_code.as_deref(),
        Some("inbound_dispatch_timeout" | "internal_recovery_required")
    ) {
        return false;
    }
    metadata
        .get("limitation_codes")
        .or_else(|| metadata.get("limitationCodes"))
        .and_then(Value::as_array)
        .is_some_and(|codes| {
            codes
                .iter()
                .filter_map(safe_token)
                .take(8)
                .any(|code| code == "internal_recovery_required")
        })
}

fn terminal_claim(value: &Value) -> Option<String> {
    value
        .get("metadata")
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get("terminalClaimId"))
        .and_then(safe_token)
}

fn read(root: &Path, state: &str, queue_id: &str) -> Option<Value> {
    let path = root
        .join("runtime/inbound-events")
        .join(state)
        .join(format!("{queue_id}.json"));
    let bytes = std::fs::read(path).ok()?;
    let value = serde_json::from_slice::<Value>(&bytes).ok()?;
    value.is_object().then_some(value)
}

fn safe_queue_id(value: &Value) -> Option<String> {
    let token = safe_token(value)?;
    (!token.contains("..") && !token.contains('/') && !token.contains('\\')).then_some(token)
}

fn safe_token(value: &Value) -> Option<String> {
    let text = crate::public_text::trim_js_whitespace(value.as_str()?);
    if text.is_empty()
        || !text
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | ':' | '.' | '/' | '-'))
    {
        return None;
    }
    Some(text.chars().take(96).collect())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn event(limited: bool) -> TranscriptEvent {
        let mut metadata = json!({
            "queueId":"queue-1",
            "dispatchClaimId":"claim-1"
        });
        if limited {
            metadata["limitation_codes"] = json!(["internal_recovery_required"]);
        }
        TranscriptEvent {
            event_id: "outbound-1".into(),
            session_id: "butler/app-general".into(),
            kind: "outbound".into(),
            timestamp: "2026-09-14T00:00:00.000Z".into(),
            payload: crate::json::json_object!({"metadata":metadata}),
            transport: Some("app".into()),
            metadata: None,
        }
    }

    #[test]
    fn claim_mismatch_rejects_and_recoverable_failure_requires_limitation() {
        let root =
            std::env::temp_dir().join(format!("butler-terminal-records-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let processed = root.join("runtime/inbound-events/processed");
        let failed = root.join("runtime/inbound-events/failed");
        std::fs::create_dir_all(&processed).unwrap();
        std::fs::create_dir_all(&failed).unwrap();

        std::fs::write(
            processed.join("queue-1.json"),
            r#"{"metadata":{"terminalClaimId":"other"}}"#,
        )
        .unwrap();
        assert_eq!(disposition(&root, &event(false)), Disposition::Reject);
        std::fs::remove_file(processed.join("queue-1.json")).unwrap();

        std::fs::write(
            failed.join("queue-1.json"),
            r#"{"metadata":{"terminalClaimId":"claim-1","failure":{"code":"inbound_dispatch_timeout"}}}"#,
        )
        .unwrap();
        assert_eq!(disposition(&root, &event(false)), Disposition::Reject);
        assert_eq!(disposition(&root, &event(true)), Disposition::Accept);
        let _ = std::fs::remove_dir_all(root);
    }
}
