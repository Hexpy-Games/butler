//! Validate source meaning schema and reference bounds before constructing graph facts.

use std::collections::HashSet;

use serde_json::{Map, Value};

use super::{Meaning, Passage};
use crate::cognition::{CognitionError, CognitionResult};

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
    for (index, entity) in entities.iter().enumerate() {
        let object = object(entity, &["name", "evidence"])?;
        let name = string(object.get("name"))?;
        let size = crate::segmentation::grapheme_segments(name).count();
        if size > 256 {
            return Err(CognitionError::new(
                "memory_extract_invalid_output",
                format!(
                    "memory_extract_invalid_output entity={index} field=name graphemes={size} limit=256"
                ),
            ));
        }
        evidence(object.get("evidence"), passages)?;
    }
    for item in items {
        let o = item.as_object().ok_or_else(invalid_meaning)?;
        let kind = o
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(invalid_meaning)?;
        match kind {
            "fact" | "preference" | "goal" | "decision" | "question" | "proposal" | "request"
            | "inference" => {
                object(item, &["kind", "subject", "text", "evidence"])?;
                nullable_entity(o.get("subject"), entities.len())?;
                string(o.get("text"))?;
            }
            "relation" | "not_relation" => {
                object(item, &["kind", "from", "predicate", "to", "evidence"])?;
                entity(o.get("from"), entities.len())?;
                entity(o.get("to"), entities.len())?;
                if !matches!(
                    o.get("predicate").and_then(Value::as_str),
                    Some(
                        "likes"
                            | "dislikes"
                            | "decided"
                            | "belongs_to"
                            | "depends_on"
                            | "related_to"
                    )
                ) {
                    return Err(invalid_meaning());
                }
            }
            "requires" => {
                object(
                    item,
                    &["kind", "subject", "action", "condition", "evidence"],
                )?;
                entity(o.get("subject"), entities.len())?;
                string(o.get("action"))?;
                let mut atoms = 0;
                condition(o.get("condition"), entities.len(), 0, &mut atoms)?;
            }
            "change" => {
                object(
                    item,
                    &["kind", "subject", "field", "old", "new", "evidence"],
                )?;
                nullable_entity(o.get("subject"), entities.len())?;
                string(o.get("field"))?;
                nullable_string(o.get("old"))?;
                string(o.get("new"))?;
            }
            _ => return Err(invalid_meaning()),
        }
        evidence(o.get("evidence"), passages)?;
    }
    for attribute in attributes {
        let o = attribute.as_object().ok_or_else(invalid_meaning)?;
        match o.get("kind").and_then(Value::as_str) {
            Some("alias") => {
                object(attribute, &["kind", "entity", "name", "evidence"])?;
                entity(o.get("entity"), entities.len())?;
                string(o.get("name"))?;
                evidence(o.get("evidence"), passages)?;
            }
            Some("importance") => {
                object(attribute, &["kind", "item", "value"])?;
                entity(o.get("item"), items.len())?;
                if o.get("value").and_then(Value::as_str) != Some("high") {
                    return Err(invalid_meaning());
                }
            }
            Some("validity") => {
                object(attribute, &["kind", "item", "from", "to"])?;
                entity(o.get("item"), items.len())?;
                nullable_string(o.get("from"))?;
                nullable_string(o.get("to"))?;
            }
            _ => return Err(invalid_meaning()),
        }
    }
    serde_json::from_value(value).map_err(|_| invalid_meaning())
}

fn condition(
    value: Option<&Value>,
    entities: usize,
    depth: usize,
    atoms: &mut usize,
) -> CognitionResult<()> {
    if depth > 4 {
        return Err(error("memory_extract_invalid_condition"));
    }
    let o = value
        .and_then(Value::as_object)
        .ok_or_else(|| error("memory_extract_invalid_condition"))?;
    if o.contains_key("subject") {
        if o.len() != 2 || !o.contains_key("state") {
            return Err(error("memory_extract_invalid_condition"));
        }
        nullable_entity(o.get("subject"), entities)?;
        if string(o.get("state"))?.trim().is_empty() {
            return Err(error("memory_extract_invalid_condition"));
        }
        *atoms += 1;
        if *atoms > 16 {
            return Err(error("memory_extract_invalid_condition"));
        }
    } else if o.contains_key("not") {
        if o.len() != 1 {
            return Err(error("memory_extract_invalid_condition"));
        }
        condition(o.get("not"), entities, depth + 1, atoms)?;
    } else {
        let key = if o.contains_key("all") {
            "all"
        } else if o.contains_key("any") {
            "any"
        } else {
            return Err(error("memory_extract_invalid_condition"));
        };
        if o.len() != 1 {
            return Err(error("memory_extract_invalid_condition"));
        }
        let children = o
            .get(key)
            .and_then(Value::as_array)
            .ok_or_else(|| error("memory_extract_invalid_condition"))?;
        if children.is_empty() || children.len() > 16 {
            return Err(error("memory_extract_invalid_condition"));
        }
        for child in children {
            condition(Some(child), entities, depth + 1, atoms)?
        }
    }
    Ok(())
}

pub(super) fn map_condition(value: &Value) -> Value {
    // Conditions were validated as objects; anything else maps to null.
    let Some(object) = value.as_object() else {
        return Value::Null;
    };
    if let Some(subject) = object.get("subject") {
        return serde_json::json!({"subject":subject.as_u64().map(|index|format!("n{index}")),
            "state":object.get("state")});
    }
    if let Some(child) = object.get("not") {
        return serde_json::json!({"not":map_condition(child)});
    }
    let key = if object.contains_key("all") {
        "all"
    } else {
        "any"
    };
    let children = object
        .get(key)
        .and_then(Value::as_array)
        .map(|children| children.iter().map(map_condition).collect())
        .unwrap_or_default();
    Value::Object(Map::from_iter([(key.into(), Value::Array(children))]))
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
fn entity(value: Option<&Value>, entities: usize) -> CognitionResult<usize> {
    let n = value
        .and_then(Value::as_u64)
        .ok_or_else(|| error("memory_extract_invalid_ref"))?;
    if n as usize >= entities {
        return Err(error("memory_extract_invalid_ref"));
    }
    Ok(n as usize)
}
fn nullable_entity(value: Option<&Value>, entities: usize) -> CognitionResult<()> {
    if value.is_some_and(Value::is_null) {
        Ok(())
    } else {
        entity(value, entities).map(|_| ())
    }
}
fn evidence(value: Option<&Value>, passages: &[Passage]) -> CognitionResult<()> {
    let items = value
        .and_then(Value::as_array)
        .ok_or_else(|| error("memory_extract_invalid_evidence"))?;
    if items.is_empty() || items.len() > 4 {
        return Err(error("memory_extract_invalid_evidence"));
    }
    let mut seen = HashSet::new();
    for item in items {
        let Some(id) = item.as_u64() else {
            return Err(error("memory_extract_invalid_evidence"));
        };
        if id as usize >= passages.len() || !seen.insert(id) {
            return Err(error("memory_extract_invalid_evidence"));
        }
    }
    Ok(())
}
fn invalid_meaning() -> CognitionError {
    error("memory_extract_invalid_meaning")
}
fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
