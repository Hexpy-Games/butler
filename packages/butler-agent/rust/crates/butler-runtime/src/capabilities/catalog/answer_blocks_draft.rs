//! Closed draft units and item-local validation. No persistence or public raw arguments.
use super::{AnswerBlocksContext, normalize, normalize_unit, scanner, validate_draft_unit};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

/// One closed unit awaiting the agent's asset/source evidence.
#[derive(Clone, Debug)]
pub struct AnswerBlocksDraftUnit {
    /// Block position within the call, never the provider call id.
    pub bi: usize,
    /// Container-relative closed child or tab label path.
    pub path: Vec<String>,
    /// Closed field/list name, absent at block close.
    pub field: Option<String>,
    /// Item position, absent for fields and structural closes.
    pub index: Option<usize>,
    /// Decoded value, absent for list/block closes.
    pub value: Option<Value>,
}

/// Validated render operation in call order; wire names match the streaming design.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AnswerBlocksDraftOp {
    /// Consecutive operation sequence, starting at one.
    pub seq: u64,
    #[serde(flatten)]
    /// Operation payload, containing only normalized and validated closed units.
    pub value: Value,
}

#[derive(Default)]
struct Block {
    fields: serde_json::Map<String, Value>,
    seen: HashSet<String>,
    pending: Vec<AnswerBlocksDraftUnit>,
    opened: bool,
}

/// Incremental per-call parser, bounded by the final 32 KB contract.
#[derive(Default)]
pub struct AnswerBlocksParser {
    scanner: scanner::Scanner,
    blocks: HashMap<usize, Block>,
    seq: u64,
}

impl AnswerBlocksParser {
    /// Scans exactly the new bytes, including fragments splitting a UTF-8 character.
    pub fn push(&mut self, delta: &[u8]) -> Vec<AnswerBlocksDraftUnit> {
        self.scanner
            .push(delta)
            .into_iter()
            .filter_map(|unit| {
                let bi = unit.path.get(1)?.parse().ok()?;
                if bi >= 8 {
                    return None;
                }
                Some(AnswerBlocksDraftUnit {
                    bi,
                    path: unit.path[2..].to_vec(),
                    field: unit.path.get(2).cloned(),
                    index: unit.path.get(3).and_then(|index| index.parse().ok()),
                    value: unit.value,
                })
            })
            .collect()
    }

    /// Normalizes and validates before releasing any renderable item.
    pub fn apply(
        &mut self,
        mut unit: AnswerBlocksDraftUnit,
        context: &AnswerBlocksContext<'_>,
    ) -> Vec<AnswerBlocksDraftOp> {
        if let Some(value) = &mut unit.value {
            normalize_unit(value);
        }
        let block = self.blocks.entry(unit.bi).or_default();
        let ready = block.opened
            && (unit.field.as_deref() != Some("rows") || block.fields.contains_key("columns"));
        if !ready && unit.field.as_deref() != Some("type") {
            block.pending.push(unit);
            return Vec::new();
        }
        let mut values = Vec::new();
        stage_evidence(block, &unit, context);
        if needs_evidence(block, &unit) {
            block.pending.push(unit);
            return Vec::new();
        }
        let closing = unit.field.is_none();
        if closing {
            values.extend(flush_pending(block, context));
        }
        if let Some(value) = apply(block, &unit, context) {
            values.push(value);
        }
        if closing {
            block.pending.clear();
        } else if block.opened {
            values.extend(flush_pending(block, context));
        }
        values
            .into_iter()
            .map(|value| {
                self.seq += 1;
                AnswerBlocksDraftOp {
                    seq: self.seq,
                    value,
                }
            })
            .collect()
    }
}

fn apply(
    block: &mut Block,
    unit: &AnswerBlocksDraftUnit,
    context: &AnswerBlocksContext<'_>,
) -> Option<Value> {
    let bi = unit.bi;
    let Some(field) = unit.field.as_deref() else {
        return block.opened.then(|| json!({"op":"block_end", "bi":bi}));
    };
    let Some(value) = &unit.value else {
        return (block.opened
            && unit.index.is_none()
            && matches!(field, "items" | "rows" | "blocks" | "tabs"))
        .then(|| json!({"op":"list_end", "bi":bi,"list":field}));
    };
    if unit.path.len() > 2 {
        return nested(block, unit, context);
    }
    if field == "type" {
        let mut spec = json!({"blocks":[{"type":value}]});
        normalize(&mut spec);
        let normalized = spec["blocks"][0].clone();
        if !validate_draft_unit(&normalized, "type", None, value, context) || block.opened {
            return None;
        }
        block.fields = normalized.as_object()?.clone();
        block.opened = true;
        return Some(json!({"op":"block","bi":bi,"value":normalized}));
    }
    let metadata = Value::Object(block.fields.clone());
    if !validate_draft_unit(&metadata, field, unit.index, value, context) {
        return None;
    }
    if let Some(index) = unit.index {
        if let Some(key) = value.get("key").and_then(Value::as_str)
            && !block.seen.insert(key.to_owned())
        {
            return None;
        }
        Some(json!({"op":"item","bi":bi,"list":field,"index":index,"value":value}))
    } else {
        block.fields.insert(field.to_owned(), value.clone());
        Some(json!({"op":"field","bi":bi,"field":field,"value":value}))
    }
}

fn needs_evidence(block: &Block, unit: &AnswerBlocksDraftUnit) -> bool {
    if unit.field.as_deref() == Some("rows") {
        return !block.fields.contains_key("columns");
    }
    if unit.field.as_deref() == Some("checked") {
        return !block.fields.contains_key("source");
    }
    // A block-level source is only shown once `checked` proved it was read;
    // until then it is staged for validation but never released.
    if block.fields.get("type").and_then(Value::as_str) == Some("chart")
        && unit.index.is_none()
        && unit.field.as_deref() == Some("source")
    {
        return !block.fields.contains_key("checked");
    }
    unit.field.as_deref() == Some("series")
        && (!block.fields.contains_key("source") || !block.fields.contains_key("checked"))
}

fn stage_evidence(
    block: &mut Block,
    unit: &AnswerBlocksDraftUnit,
    context: &AnswerBlocksContext<'_>,
) {
    if unit.index.is_none()
        && matches!(unit.field.as_deref(), Some("source" | "checked"))
        && let (Some(field), Some(value)) = (&unit.field, &unit.value)
        && (field == "source" || block.fields.contains_key("source"))
        && validate_draft_unit(
            &Value::Object(block.fields.clone()),
            field,
            None,
            value,
            context,
        )
    {
        block.fields.insert(field.clone(), value.clone());
    }
}

fn flush_pending(block: &mut Block, context: &AnswerBlocksContext<'_>) -> Vec<Value> {
    // Dependencies can precede type in JSON. Prime them before checking deferred
    // units, so every released unit still closes before its block_end operation.
    for field in ["source", "columns", "x", "checked"] {
        for unit in &block.pending {
            if unit.field.as_deref() == Some(field)
                && unit.index.is_none()
                && let Some(value) = &unit.value
                && validate_draft_unit(
                    &Value::Object(block.fields.clone()),
                    field,
                    None,
                    value,
                    context,
                )
            {
                block.fields.insert(field.into(), value.clone());
            }
        }
    }
    let pending = std::mem::take(&mut block.pending);
    let mut values = Vec::new();
    for unit in pending {
        if needs_evidence(block, &unit) {
            block.pending.push(unit);
        } else if let Some(value) = apply(block, &unit, context) {
            values.push(value);
        }
    }
    values
}

fn nested(
    block: &Block,
    unit: &AnswerBlocksDraftUnit,
    context: &AnswerBlocksContext<'_>,
) -> Option<Value> {
    if block.fields.get("type")?.as_str()? != "tabs" || unit.path.first()?.as_str() != "tabs" {
        return None;
    }
    let tab = unit.index?;
    if tab >= 5 {
        return None;
    }
    let value = unit.value.as_ref()?;
    if unit.path.len() == 3 && unit.path[2] == "label" {
        let label = value.as_str()?;
        if label.is_empty() || label.chars().count() > 24 {
            return None;
        }
        return Some(json!({"op":"tab", "bi":unit.bi, "index":tab, "label":label}));
    }
    if unit.path.len() != 4 || unit.path[2] != "blocks" {
        return None;
    }
    let child: usize = unit.path[3].parse().ok()?;
    if child >= 4 {
        return None;
    }
    let tab_value = json!({"label":"tab", "blocks":[value]});
    let metadata = Value::Object(block.fields.clone());
    if !validate_draft_unit(&metadata, "tabs", Some(tab), &tab_value, context) {
        return None;
    }
    Some(json!({"op":"child", "bi":unit.bi, "tab":tab, "index":child, "value":value}))
}
