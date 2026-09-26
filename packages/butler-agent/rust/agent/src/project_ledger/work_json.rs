//! Source canonical Project Work JSON shared by managed readers and writers.

use serde_json::{Map, Value};
use unicode_normalization::UnicodeNormalization;

use super::ProjectLedgerReadError;
use crate::{json, locale::LocaleCollation};

pub(super) fn canonical(
    value: &Value,
    collation: &LocaleCollation,
) -> Result<String, ProjectLedgerReadError> {
    let normalized = normalize(value)?;
    json::stringify_sorted(&normalized, &|left, right| collation.compare(left, right))
        .map_err(|_| invalid())
}

fn normalize(value: &Value) -> Result<Value, ProjectLedgerReadError> {
    match value {
        Value::String(text) => Ok(Value::String(text.nfc().collect())),
        Value::Array(items) => Ok(Value::Array(
            items.iter().map(normalize).collect::<Result<_, _>>()?,
        )),
        Value::Object(items) => {
            if items.len() > 512 {
                return Err(invalid());
            }
            let mut result = Map::with_capacity(items.len());
            for (key, value) in items {
                if result
                    .insert(key.nfc().collect(), normalize(value)?)
                    .is_some()
                {
                    return Err(invalid());
                }
            }
            Ok(Value::Object(result))
        }
        _ => Ok(value.clone()),
    }
}

fn invalid() -> ProjectLedgerReadError {
    ProjectLedgerReadError::RecordShow("project_work_managed_record_invalid")
}
