//! Insertion-order-preserving, positional continuation deltas.
use super::super::{
    StorageCode, StorageResult,
    common::{error, stringify},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Delta<T = Value> {
    pub v: u8,
    pub base: String,
    pub base_count: usize,
    pub count: usize,
    pub ops: Vec<Op<T>>,
}
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
pub(super) enum Op<T = Value> {
    Copy(CopyOp),
    Literal(LiteralOp<T>),
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CopyOp {
    pub c: [usize; 2],
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct LiteralOp<T = Value> {
    pub l: Vec<T>,
}

pub(super) fn invalid() -> super::super::StorageError {
    error(
        StorageCode::ModelAcceptanceDeltaInvalid,
        "invalid acceptance delta",
    )
}

// Passthrough: provider continuation items retain their serialized key order.
pub(super) fn split_stateless(value: &mut Value) -> Option<Vec<Value>> {
    let continuation = value.get_mut("continuation")?.as_object_mut()?;
    if continuation.keys().next_back()?.as_str() != "statelessInput"
        || !continuation.get("statelessInput")?.is_array()
    {
        return None;
    }
    match continuation.shift_remove("statelessInput")? {
        Value::Array(items) => Some(items),
        _ => None,
    }
}

// Passthrough: compare the cached, insertion-order-preserving item bytes.
pub(super) fn encode(
    base_id: &str,
    base: &[String],
    items: &[String],
) -> StorageResult<Option<String>> {
    let mut ops = Vec::new();
    let mut literal_bytes = 0usize;
    let mut full_bytes = 2usize;
    for (j, raw) in items.iter().enumerate() {
        full_bytes += raw.len() + usize::from(j > 0);
        if base.get(j) == Some(raw) {
            if let Some(Op::Copy(op)) = ops.last_mut() {
                op.c[1] += 1;
            } else {
                ops.push(Op::Copy(CopyOp { c: [j, 1] }));
            }
        } else {
            literal_bytes += raw.len();
            if let Some(Op::Literal(op)) = ops.last_mut() {
                op.l.push(raw.as_str());
            } else {
                ops.push(Op::Literal(LiteralOp {
                    l: vec![raw.as_str()],
                }));
            }
        }
    }
    if literal_bytes.saturating_mul(2) >= full_bytes {
        return Ok(None);
    }
    let delta = Delta {
        v: 1,
        base: base_id.into(),
        base_count: base.len(),
        count: items.len(),
        ops,
    };
    if !self_check(base, items, &delta) {
        butler_core::diagnostic!("model_acceptance_delta_self_check_failed");
        return Ok(None);
    }
    encoded_delta(&delta).map(Some)
}

// Apply the validated ops to borrowed strings, then compare every item byte for byte.
fn self_check(base: &[String], items: &[String], delta: &Delta<&str>) -> bool {
    if validate(base.len(), delta).is_err() {
        return false;
    }
    let mut applied = Vec::with_capacity(delta.count);
    for op in &delta.ops {
        match op {
            Op::Copy(op) => {
                let Some(copied) = base.get(op.c[0]..op.c[0] + op.c[1]) else {
                    return false;
                };
                applied.extend(copied.iter().map(String::as_str));
            }
            Op::Literal(op) => applied.extend(op.l.iter().copied()),
        }
    }
    applied.len() == items.len()
        && applied
            .iter()
            .zip(items)
            .all(|(applied, item)| *applied == item)
}

// Passthrough: literals are complete JSON from stringify, never interpolated content.
fn encoded_delta(delta: &Delta<&str>) -> StorageResult<String> {
    let mut raw = format!(
        "{{\"v\":1,\"base\":{},\"baseCount\":{},\"count\":{},\"ops\":[",
        stringify(&Value::String(delta.base.clone()))?,
        delta.base_count,
        delta.count,
    );
    for (i, op) in delta.ops.iter().enumerate() {
        if i > 0 {
            raw.push(',');
        }
        match op {
            Op::Copy(op) => raw.push_str(&format!("{{\"c\":[{},{}]}}", op.c[0], op.c[1])),
            Op::Literal(op) => {
                raw.push_str("{\"l\":[");
                for (i, item) in op.l.iter().enumerate() {
                    if i > 0 {
                        raw.push(',');
                    }
                    raw.push_str(item);
                }
                raw.push_str("]}");
            }
        }
    }
    raw.push_str("]}");
    Ok(raw)
}

/// Validate all positional guards before taking ownership of a cached vector.
pub(super) fn validate<T>(base_count: usize, delta: &Delta<T>) -> StorageResult<()> {
    if delta.v != 1 || base_count != delta.base_count {
        return Err(invalid());
    }
    let mut output = 0usize;
    for op in &delta.ops {
        match op {
            Op::Copy(op) => {
                let [start, len] = op.c;
                let end = start.checked_add(len).ok_or_else(invalid)?;
                if len == 0 || start != output || end > base_count || end > delta.count {
                    return Err(invalid());
                }
                output = end;
            }
            Op::Literal(op) => {
                output = output.checked_add(op.l.len()).ok_or_else(invalid)?;
                if op.l.is_empty() || output > delta.count {
                    return Err(invalid());
                }
            }
        }
    }
    if output != delta.count {
        return Err(invalid());
    }
    Ok(())
}

// Passthrough: callers validate every delta before moving the cached base.
pub(super) fn apply_validated(mut items: Vec<Value>, delta: &Delta) -> Vec<Value> {
    let mut output = 0usize;
    for op in &delta.ops {
        match op {
            Op::Copy(op) => {
                output += op.c[1];
            }
            Op::Literal(op) => {
                for value in &op.l {
                    if let Some(slot) = items.get_mut(output) {
                        *slot = value.clone();
                    } else {
                        items.push(value.clone());
                    }
                    output += 1;
                }
            }
        }
    }
    items.truncate(output);
    items
}

// Passthrough: account for literals without scanning or cloning retained items.
pub(super) fn literal_bytes(delta: &Delta) -> StorageResult<usize> {
    let mut bytes = 0usize;
    for op in &delta.ops {
        if let Op::Literal(op) = op {
            for item in &op.l {
                bytes += stringify(item)?.len() * 3 + 160;
            }
        }
    }
    Ok(bytes)
}

pub(super) fn parse(raw: Option<&str>) -> StorageResult<Delta> {
    let delta: Delta = serde_json::from_str(raw.ok_or_else(invalid)?).map_err(|_| invalid())?;
    if delta.v != 1 || delta.base.is_empty() {
        return Err(invalid());
    }
    Ok(delta)
}
