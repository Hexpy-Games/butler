use serde_json::{Map, Value};

const SCHEMA: &str = "butler.authority-outcome-receipt.v1";
const ERRORS: &[&str] = &[
    "effect_work_plan_missing",
    "effect_plan_review_required",
    "effect_action_not_found",
    "effect_action_ambiguous",
    "effect_request_invalid",
    "effect_identity_conflict",
    "effect_access_denied",
    "effect_cancelled",
    "effect_dispatch_failed",
    "effect_reconciliation_required",
    "effect_journal_conflict",
];

pub(super) fn parse(value: &str) -> Option<Value> {
    if crate::public_text::trim_js_whitespace(value).is_empty() {
        return None;
    }
    let parsed: Value = serde_json::from_str(value).ok()?;
    let record = parsed.as_object()?;
    if record.get("schema")?.as_str()? != SCHEMA {
        return None;
    }
    let outcome = record.get("outcome")?.as_str()?;
    let expected = match outcome {
        "applied" => &[
            "dispatchAttempt",
            "evidenceRef",
            "journalEffectId",
            "outcome",
            "schema",
        ][..],
        "uncertain" => &[
            "dispatchAttempt",
            "errorCode",
            "evidenceRef",
            "journalEffectId",
            "outcome",
            "schema",
        ][..],
        _ => return None,
    };
    if !exact_keys(record, expected) {
        return None;
    }
    let evidence = record
        .get("evidenceRef")?
        .as_str()?
        .strip_prefix("authority-evidence-")?;
    let journal = record
        .get("journalEffectId")?
        .as_str()?
        .strip_prefix("guided-effect-")?;
    if !sha(evidence) || !sha(journal) {
        return None;
    }
    let attempt = record.get("dispatchAttempt")?.as_f64()?;
    if !attempt.is_finite() || attempt.fract() != 0.0 || attempt <= 0.0 {
        return None;
    }
    if outcome == "uncertain" && !ERRORS.contains(&record.get("errorCode")?.as_str()?) {
        return None;
    }
    Some(parsed)
}
fn sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn exact_keys(record: &Map<String, Value>, expected: &[&str]) -> bool {
    record.len() == expected.len() && expected.iter().all(|key| record.contains_key(*key))
}
