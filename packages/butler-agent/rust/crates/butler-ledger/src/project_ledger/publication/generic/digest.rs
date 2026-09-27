use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::contracts::LedgerEffectError;
use butler_core::locale::LocaleCollation;

pub(super) fn request(
    updates: &Value,
    collation: &LocaleCollation,
) -> Result<String, LedgerEffectError> {
    let sorted = sort(updates, collation);
    let encoded = butler_core::json::stringify(&sorted).map_err(LedgerEffectError::uncertain)?;
    Ok(sha(encoded.as_bytes()))
}

pub(super) fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn sort(value: &Value, collation: &LocaleCollation) -> Value {
    match value {
        Value::Array(values) => {
            Value::Array(values.iter().map(|value| sort(value, collation)).collect())
        }
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_by(|left, right| collation.compare(left, right));
            let mut ordered = Map::new();
            for key in keys {
                ordered.insert(key.clone(), sort(&values[key], collation));
            }
            Value::Object(ordered)
        }
        _ => value.clone(),
    }
}
