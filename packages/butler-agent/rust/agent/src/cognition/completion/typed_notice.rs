//! Durable typed-owner notices shared by explicit rules and reviewed task reports.

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::cognition::{CognitionError, CognitionResult};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum TypedMemorySourceNotice {
    TaskReport {
        record_id: String,
        revision: String,
        operation_id: String,
    },
    ExplicitRule {
        record_id: String,
        revision: String,
        operation_id: String,
    },
}

impl TypedMemorySourceNotice {
    pub(super) fn source_json(&self) -> CognitionResult<String> {
        match self {
            Self::TaskReport {
                record_id,
                revision,
                operation_id,
            } => Ok(format!(
                "{{\"kind\":\"task_report\",\"record_id\":{},\"revision\":{},\"operation_id\":{}}}",
                quote(record_id)?,
                quote(revision)?,
                quote(operation_id)?,
            )),
            Self::ExplicitRule {
                record_id,
                revision,
                operation_id,
            } => Ok(format!(
                "{{\"kind\":\"explicit_record\",\"record_kind\":\"rule\",\"record_id\":{},\"revision\":{},\"operation_id\":{}}}",
                quote(record_id)?,
                quote(revision)?,
                quote(operation_id)?,
            )),
        }
    }

    pub(super) fn job_id(&self) -> CognitionResult<String> {
        let source = self.source_json()?;
        Ok(format!("{:x}", Sha256::digest(source.as_bytes())))
    }
}

fn quote(value: &str) -> CognitionResult<String> {
    crate::json::stringify(&Value::String(value.to_owned()))
        .map_err(|error| CognitionError::new("memory_queue_invalid_json", error.to_string()))
}
