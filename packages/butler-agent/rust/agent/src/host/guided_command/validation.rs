//! Exact JSON capability receipts for bounded structured command validations.

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::json;
use uuid::Uuid;

use super::artifacts::Artifact;
use super::evidence;
use super::structured_stdout::Validation;
use crate::btcc::BtccError;

struct SafeText {
    valid: String,
    escaped_units: Vec<(char, u16)>,
}

fn valid_with_markers(units: &[u16], next_marker: &mut u32, forbidden: &[u16]) -> SafeText {
    let mut valid = String::new();
    let mut escaped_units = Vec::new();
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok(character) => valid.push(character),
            Err(error) => {
                while forbidden.contains(&(*next_marker as u16))
                    || units.contains(&(*next_marker as u16))
                {
                    *next_marker += 1;
                }
                // Markers are private-use scalars, which are always valid chars.
                let character = char::from_u32(*next_marker).unwrap_or(char::REPLACEMENT_CHARACTER);
                valid.push(character);
                escaped_units.push((character, error.unpaired_surrogate()));
                *next_marker += 1;
            }
        }
    }
    SafeText {
        valid,
        escaped_units,
    }
}

fn safe_scope(units: &[u16], fallback: &str, next_marker: &mut u32, forbidden: &[u16]) -> SafeText {
    let represented = valid_with_markers(units, next_marker, forbidden);
    let sanitized = crate::public_text::sanitize_public_text(&represented.valid, fallback);
    let bounded: Vec<u16> = sanitized.encode_utf16().take(180).collect();
    let mut result = valid_with_markers(&bounded, next_marker, forbidden);
    // Markers from input that survive sanitization retain their source unit.
    for (marker, unit) in represented.escaped_units {
        if result.valid.contains(marker) {
            result.escaped_units.push((marker, unit));
        }
    }
    if result.valid.is_empty() {
        result.valid = fallback.into();
    }
    result
}

fn validation_receipt(value: &Validation) -> Result<String, BtccError> {
    let passed = value.result == "passed";
    let maturity = if passed {
        "verified"
    } else if value.result == "partial" {
        "candidate"
    } else {
        "rejected"
    };
    let mut next_marker = 0xe000;
    let mut forbidden = value.suite.clone();
    if let Some(failure) = &value.failure_summary {
        forbidden.extend_from_slice(failure);
    }
    let suite = safe_scope(&value.suite, "validation", &mut next_marker, &forbidden);
    let failure = value.failure_summary.as_deref().map(|text| {
        safe_scope(
            text,
            "Validation did not pass.",
            &mut next_marker,
            &forbidden,
        )
    });
    let mut scope = json!({"suite":suite.valid,"result":value.result});
    if let Some(failure) = &failure {
        scope["failure_summary"] = json!(failure.valid);
    }
    let limitations = failure.as_ref().map_or_else(Vec::new, |value| {
        vec![crate::public_text::sanitize_public_text(
            &value.valid,
            "Evidence limitation was recorded.",
        )]
    });
    let receipt = json!({
        "receipt_id":format!("ecr-{}", &Uuid::new_v4().to_string()[..12]),
        "schema_version":"evidence-capability.v1",
        "producer":{"kind":"tool","name":"run_command"},
        "capability":"validation_passed","evidence_kind":"execution_result",
        "maturity":maturity,"confidence":if passed { 0.95 } else if value.result == "partial" { 0.55 } else { 0.25 },
        "verified":passed,
        "summary":if passed { "A validation suite completed successfully." } else { "A validation suite did not complete successfully." },
        "scope":scope,"references":[],"limitations":limitations,
        "created_at":DateTime::<Utc>::from(std::time::SystemTime::now()).to_rfc3339_opts(SecondsFormat::Millis,true),
    });
    let mut encoded = crate::json::stringify(&receipt).map_err(|_| error())?;
    for text in std::iter::once(&suite).chain(failure.as_ref()) {
        for (marker, unit) in &text.escaped_units {
            encoded = encoded.replace(*marker, &format!("\\u{unit:04x}"));
        }
    }
    Ok(encoded)
}

pub(super) fn capability_receipts(
    exit: Option<i32>,
    timed_out: bool,
    suppressed: bool,
    budgeted: bool,
    artifacts: &[Artifact],
    validations: &[Validation],
) -> Result<String, BtccError> {
    let ordinary = evidence::capability_receipts(exit, timed_out, suppressed, budgeted, artifacts);
    let mut encoded = String::from("[");
    for (index, receipt) in ordinary.iter().take(1).enumerate() {
        if index > 0 {
            encoded.push(',');
        }
        encoded.push_str(&crate::json::stringify(receipt).map_err(|_| error())?);
    }
    for validation in validations {
        encoded.push(',');
        encoded.push_str(&validation_receipt(validation)?);
    }
    for receipt in ordinary.iter().skip(1) {
        encoded.push(',');
        encoded.push_str(&crate::json::stringify(receipt).map_err(|_| error())?);
    }
    encoded.push(']');
    Ok(encoded)
}

fn error() -> BtccError {
    BtccError::new(
        "command_result_encoding_failed",
        "command_result_encoding_failed",
    )
}
