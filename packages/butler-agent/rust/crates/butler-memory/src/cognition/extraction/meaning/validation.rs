//! Parse boundary of the meaning stage: checks the model's JSON against the
//! contract (exact key sets, kinds, entity/item/passage bounds, condition
//! shape) before typing it as [`Meaning`].
//!
//! The first violation's code is sent back to the model as the repair
//! instruction, so checks run in document order (entities, items,
//! attributes) and keep their specific codes; this is why the checks walk
//! `Value` instead of relying on serde's typed errors.

use crate::cognition::CognitionCode;
use std::collections::HashSet;

use serde_json::{Map, Value};

use super::{Meaning, Passage};
use crate::cognition::{CognitionError, CognitionResult};

/// Validated counts the later sections are bounded by.
struct Bounds<'a> {
    entities: usize,
    items: usize,
    passages: &'a [Passage],
}

pub(super) fn validate(value: Value, passages: &[Passage]) -> CognitionResult<Meaning> {
    let root = object(&value, &["status", "entities", "items", "attributes"])?;
    let status = root
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(invalid_meaning)?;
    if !matches!(status, "processed" | "needs_context" | "unsupported") {
        return Err(invalid_meaning());
    }
    let entities = array(root.get("entities"), 32)?;
    let items = array(root.get("items"), 48)?;
    let attributes = array(root.get("attributes"), 48)?;
    if status != "processed"
        && (!entities.is_empty() || !items.is_empty() || !attributes.is_empty())
    {
        return Err(invalid_meaning());
    }
    let bounds = Bounds {
        entities: entities.len(),
        items: items.len(),
        passages,
    };
    for (index, entity) in entities.iter().enumerate() {
        validate_entity(index, entity, &bounds)?;
    }
    for item in items {
        validate_item(item, &bounds)?;
    }
    for attribute in attributes {
        validate_attribute(attribute, &bounds)?;
    }
    serde_json::from_value(value).map_err(|source| invalid_meaning().with_source(source))
}

/// `{name, evidence}` with a name of at most 256 graphemes.
fn validate_entity(index: usize, entity: &Value, bounds: &Bounds<'_>) -> CognitionResult<()> {
    let object = object(entity, &["name", "evidence"])?;
    let name = string(object.get("name"))?;
    let size = butler_core::segmentation::grapheme_segments(name).count();
    if size > 256 {
        return Err(CognitionError::new(
            CognitionCode::MemoryExtractInvalidOutput,
            format!(
                "memory_extract_invalid_output entity={index} field=name graphemes={size} limit=256"
            ),
        ));
    }
    evidence(object.get("evidence"), bounds.passages)
}

/// One item: its kind's exact key set and references, then its evidence.
fn validate_item(item: &Value, bounds: &Bounds<'_>) -> CognitionResult<()> {
    let o = item.as_object().ok_or_else(invalid_meaning)?;
    let kind = o
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(invalid_meaning)?;
    let entities = bounds.entities;
    match kind {
        "fact" | "preference" | "goal" | "decision" | "question" | "proposal" | "request"
        | "inference" => {
            object(item, &["kind", "subject", "text", "evidence"])?;
            nullable_entity(o.get("subject"), entities)?;
            string(o.get("text"))?;
        }
        "relation" | "not_relation" => {
            object(item, &["kind", "from", "predicate", "to", "evidence"])?;
            entity(o.get("from"), entities)?;
            entity(o.get("to"), entities)?;
            let predicate = o.get("predicate").and_then(Value::as_str);
            if !matches!(
                predicate,
                Some("likes" | "dislikes" | "decided" | "belongs_to" | "depends_on" | "related_to")
            ) {
                return Err(invalid_meaning());
            }
        }
        "requires" => {
            object(
                item,
                &["kind", "subject", "action", "condition", "evidence"],
            )?;
            entity(o.get("subject"), entities)?;
            string(o.get("action"))?;
            let mut atoms = 0;
            condition(o.get("condition"), entities, 0, &mut atoms)?;
        }
        "change" => {
            object(
                item,
                &["kind", "subject", "field", "old", "new", "evidence"],
            )?;
            nullable_entity(o.get("subject"), entities)?;
            string(o.get("field"))?;
            nullable_string(o.get("old"))?;
            string(o.get("new"))?;
        }
        _ => return Err(invalid_meaning()),
    }
    evidence(o.get("evidence"), bounds.passages)
}

/// One attribute: an alias of an entity, or importance/validity of an item.
fn validate_attribute(attribute: &Value, bounds: &Bounds<'_>) -> CognitionResult<()> {
    let o = attribute.as_object().ok_or_else(invalid_meaning)?;
    match o.get("kind").and_then(Value::as_str) {
        Some("alias") => {
            object(attribute, &["kind", "entity", "name", "evidence"])?;
            entity(o.get("entity"), bounds.entities)?;
            string(o.get("name"))?;
            evidence(o.get("evidence"), bounds.passages)?;
        }
        Some("importance") => {
            object(attribute, &["kind", "item", "value"])?;
            entity(o.get("item"), bounds.items)?;
            if o.get("value").and_then(Value::as_str) != Some("high") {
                return Err(invalid_meaning());
            }
        }
        Some("validity") => {
            object(attribute, &["kind", "item", "from", "to"])?;
            entity(o.get("item"), bounds.items)?;
            nullable_string(o.get("from"))?;
            nullable_string(o.get("to"))?;
        }
        _ => return Err(invalid_meaning()),
    }
    Ok(())
}

/// A condition tree of depth <= 4 with at most 16 atoms in total.
fn condition(
    value: Option<&Value>,
    entities: usize,
    depth: usize,
    atoms: &mut usize,
) -> CognitionResult<()> {
    let invalid = || error(CognitionCode::MemoryExtractInvalidCondition);
    if depth > 4 {
        return Err(invalid());
    }
    let o = value.and_then(Value::as_object).ok_or_else(invalid)?;
    if o.contains_key("subject") {
        if o.len() != 2 || !o.contains_key("state") {
            return Err(invalid());
        }
        nullable_entity(o.get("subject"), entities)?;
        if string(o.get("state"))?.trim().is_empty() {
            return Err(invalid());
        }
        *atoms += 1;
        return if *atoms > 16 { Err(invalid()) } else { Ok(()) };
    }
    if o.contains_key("not") {
        if o.len() != 1 {
            return Err(invalid());
        }
        return condition(o.get("not"), entities, depth + 1, atoms);
    }
    let key = if o.contains_key("all") {
        "all"
    } else if o.contains_key("any") {
        "any"
    } else {
        return Err(invalid());
    };
    if o.len() != 1 {
        return Err(invalid());
    }
    let children = o.get(key).and_then(Value::as_array).ok_or_else(invalid)?;
    if children.is_empty() || children.len() > 16 {
        return Err(invalid());
    }
    for child in children {
        condition(Some(child), entities, depth + 1, atoms)?;
    }
    Ok(())
}

fn object<'a>(value: &'a Value, keys: &[&str]) -> CognitionResult<&'a Map<String, Value>> {
    let o = value.as_object().ok_or_else(invalid_meaning)?;
    if o.len() != keys.len() || keys.iter().any(|key| !o.contains_key(*key)) {
        return Err(invalid_meaning());
    }
    Ok(o)
}
fn array(value: Option<&Value>, max: usize) -> CognitionResult<&[Value]> {
    let a = value
        .and_then(Value::as_array)
        .ok_or_else(invalid_meaning)?;
    if a.len() > max {
        return Err(invalid_meaning());
    }
    Ok(a)
}
fn string(value: Option<&Value>) -> CognitionResult<&str> {
    let s = value.and_then(Value::as_str).ok_or_else(invalid_meaning)?;
    if s.is_empty() {
        return Err(invalid_meaning());
    }
    Ok(s)
}
fn nullable_string(value: Option<&Value>) -> CognitionResult<()> {
    if value.is_some_and(Value::is_null) {
        Ok(())
    } else {
        string(value).map(|_| ())
    }
}
/// An index below `bound` (an entity or item index).
fn entity(value: Option<&Value>, bound: usize) -> CognitionResult<usize> {
    let n = value
        .and_then(Value::as_u64)
        .ok_or_else(|| error(CognitionCode::MemoryExtractInvalidRef))?;
    let index = usize::try_from(n).unwrap_or(usize::MAX);
    if index >= bound {
        return Err(error(CognitionCode::MemoryExtractInvalidRef));
    }
    Ok(index)
}
fn nullable_entity(value: Option<&Value>, entities: usize) -> CognitionResult<()> {
    if value.is_some_and(Value::is_null) {
        Ok(())
    } else {
        entity(value, entities).map(|_| ())
    }
}
/// 1..=4 distinct passage ids.
fn evidence(value: Option<&Value>, passages: &[Passage]) -> CognitionResult<()> {
    let invalid = || error(CognitionCode::MemoryExtractInvalidEvidence);
    let items = value.and_then(Value::as_array).ok_or_else(invalid)?;
    if items.is_empty() || items.len() > 4 {
        return Err(invalid());
    }
    let mut seen = HashSet::new();
    for item in items {
        let Some(id) = item.as_u64() else {
            return Err(invalid());
        };
        if usize::try_from(id).unwrap_or(usize::MAX) >= passages.len() || !seen.insert(id) {
            return Err(invalid());
        }
    }
    Ok(())
}
fn invalid_meaning() -> CognitionError {
    error(CognitionCode::MemoryExtractInvalidMeaning)
}
fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
