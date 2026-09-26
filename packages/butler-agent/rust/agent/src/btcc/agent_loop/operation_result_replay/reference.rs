use crate::btcc::BtccError;
use crate::btcc::storage::{OperationResultReference as StoredReference, ToolJournalRecord};

use super::contracts::*;
use crate::btcc::BtccCode;

pub(super) fn reference(
    record: &ToolJournalRecord,
    stored: StoredReference,
    exact_read: bool,
) -> Result<OperationResultReference, BtccError> {
    let sha256 = record
        .result_sha256
        .clone()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| error(BtccCode::OperationResultReferenceUnavailable))?;
    if record.result.is_none() {
        return Err(error(BtccCode::OperationResultReferenceUnavailable));
    }
    let kind = match stored.kind {
        "direct" => StoredResultKind::Direct,
        "work" => StoredResultKind::Work,
        _ => return Err(error(BtccCode::OperationResultReferenceInvalid)),
    };
    Ok(OperationResultReference {
        version: OperationResultReferenceVersion::V1,
        kind: OperationResultKind::OperationResult,
        identity: OperationResultIdentity {
            kind,
            result_ref: bounded_identifier(
                &stored.result_ref,
                BtccCode::OperationResultReferenceInvalid,
            )?,
            tool_name: bounded_identifier(
                &record.tool_name.clone(),
                BtccCode::OperationResultToolNameInvalid,
            )?,
            work_id: stored
                .work_id
                .filter(|value| !value.is_empty())
                .as_ref()
                .map(|value| bounded_identifier(value, BtccCode::OperationResultWorkIdInvalid))
                .transpose()?,
        },
        integrity: OperationResultIntegrity {
            sha256,
            revision: stored.revision,
        },
        outcome: OperationResultOutcome {
            status: CompletedOnly::Completed,
            success: record
                .result
                .as_ref()
                .map(|value| value.field("ok"))
                .transpose()
                .map_err(|source| error(BtccCode::ToolJournalJsonInvalid).with_source(source))?
                .flatten()
                != Some("false"),
            verification: StoredExactAvailable::StoredExactAvailable,
            error_code: bounded_error_code(record.error_code.as_deref()),
        },
        availability: OperationResultAvailability {
            status: if exact_read {
                ExactReadAvailability::ExactReadAvailable
            } else {
                ExactReadAvailability::ReferenceOnly
            },
            capability: ReadOperationResultsOnly::ReadOperationResults,
            scope: if kind == StoredResultKind::Work {
                ExactReadScope::WorkScope
            } else {
                ExactReadScope::SameTurn
            },
        },
    })
}

fn bounded_identifier(value: &str, code: BtccCode) -> Result<String, BtccError> {
    let trimmed = crate::public_text::trim_js_whitespace(value);
    if trimmed.is_empty() || trimmed.len() > 256 {
        Err(error(code))
    } else {
        Ok(trimmed.to_owned())
    }
}

fn bounded_error_code(value: Option<&str>) -> Option<String> {
    let value = value?;
    let trimmed = crate::public_text::trim_js_whitespace(value);
    let normalized: String = trimmed
        .chars()
        .map(|value| {
            if value.is_ascii_alphanumeric() || matches!(value, '_' | '.' | '-') {
                value
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    (!normalized.is_empty()).then_some(normalized)
}

fn error(code: BtccCode) -> BtccError {
    BtccError::detected(code, code.as_str())
}
