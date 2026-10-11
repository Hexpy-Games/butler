//! Insertion-order-preserving, positional continuation deltas.
use super::super::{
    StorageCode, StorageResult,
    common::{error, stringify},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Delta {
    pub v: u8,
    pub base: String,
    pub base_count: usize,
    pub count: usize,
    pub ops: Vec<Op>,
}
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
pub(super) enum Op {
    Copy(CopyOp),
    Literal(LiteralOp),
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CopyOp {
    pub c: [usize; 2],
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct LiteralOp {
    pub l: Vec<Value>,
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

// Passthrough: exact serialized comparison of opaque provider items.
pub(super) fn encode(
    base_id: &str,
    base: &[Value],
    items: &[Value],
) -> StorageResult<Option<Delta>> {
    let mut ops = Vec::new();
    let mut literal_bytes = 0usize;
    let mut full_bytes = 2usize;
    for (j, item) in items.iter().enumerate() {
        let raw = stringify(item)?;
        full_bytes += raw.len() + usize::from(j > 0);
        let copied = base
            .get(j)
            .map(stringify)
            .transpose()?
            .is_some_and(|v| v == raw);
        if copied {
            if let Some(Op::Copy(op)) = ops.last_mut() {
                op.c[1] += 1;
            } else {
                ops.push(Op::Copy(CopyOp { c: [j, 1] }));
            }
        } else {
            literal_bytes += raw.len();
            if let Some(Op::Literal(op)) = ops.last_mut() {
                op.l.push(item.clone());
            } else {
                ops.push(Op::Literal(LiteralOp {
                    l: vec![item.clone()],
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
    let checked = apply(base.to_vec(), &delta);
    if !checked
        .as_ref()
        .is_ok_and(|checked| same_items(checked, items).unwrap_or(false))
    {
        butler_core::diagnostic!("model_acceptance_delta_self_check_failed");
        return Ok(None);
    }
    Ok(Some(delta))
}

// Passthrough: comparison includes provider object key insertion order.
fn same_items(a: &[Value], b: &[Value]) -> StorageResult<bool> {
    if a.len() != b.len() {
        return Ok(false);
    }
    for (a, b) in a.iter().zip(b) {
        if stringify(a)? != stringify(b)? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Validate all positional guards before taking ownership of a cached vector.
pub(super) fn validate(base_count: usize, delta: &Delta) -> StorageResult<()> {
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
pub(super) fn apply(items: Vec<Value>, delta: &Delta) -> StorageResult<Vec<Value>> {
    validate(items.len(), delta)?;
    Ok(apply_validated(items, delta))
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
                bytes += stringify(item)?.len() * 2 + 128;
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
