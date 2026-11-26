//! The stub server's op types, its `validateOps` port and `decide`.
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::HashMap;

#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Kind {
    Plan,
    Epic,
    Tag,
    EpicTag,
    Comment,
}

#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Action {
    Create,
    Set,
    Move,
    Delete,
    Append,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Op {
    pub(super) op_id: String,
    pub(super) entity_id: String,
    pub(super) kind: Kind,
    pub(super) action: Action,
    pub(super) base_revision: u64,
    pub(super) fields: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Ops {
    ops: Vec<Value>,
}

#[derive(Serialize)]
pub(super) struct Entity {
    entity_id: String,
    kind: Kind,
    revision: u64,
    deleted: bool,
    data: Map<String, Value>,
}

pub(super) struct StoredEntity {
    pub(super) entity: Entity,
    pub(super) field_rev: HashMap<String, u64>,
}

/// The server's `validateOps`: 1–100 ops of exactly six keys, 64 KiB each,
/// fields checked per kind and per action. Errors are (status, code).
pub(super) fn validate(body: &[u8]) -> Result<Vec<Op>, (StatusCode, &'static str)> {
    const INVALID: (StatusCode, &str) = (StatusCode::BAD_REQUEST, "invalid_request");
    if body.len() > 1024 * 1024 {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "too_large"));
    }
    let Ok(Ops { ops }) = serde_json::from_slice(body) else {
        return Err(INVALID);
    };
    if !(1..=100).contains(&ops.len()) {
        return Err(INVALID);
    }
    let mut valid = Vec::new();
    for raw in ops {
        let Ok(op) = serde_json::from_value::<Op>(raw.clone()) else {
            return Err(INVALID);
        };
        if !id(&op.op_id)
            || !reference(&json!(op.entity_id))
            || !actions(op.kind).contains(&op.action)
        {
            return Err(INVALID);
        }
        if raw.to_string().len() > 65_536 {
            return Err((StatusCode::PAYLOAD_TOO_LARGE, "too_large"));
        }
        let fields_ok = op
            .fields
            .iter()
            .all(|(key, value)| field(op.kind, key, value) == Some(true));
        let has = |key: &str| op.fields.contains_key(key);
        let moves = ["plan_id", "plan_rank"];
        let rule = match op.action {
            Action::Create | Action::Append => {
                op.base_revision == 0 && required(op.kind).iter().all(|key| has(key))
            }
            Action::Set => {
                op.base_revision >= 1 && !op.fields.is_empty() && !moves.iter().any(|key| has(key))
            }
            Action::Move => {
                op.base_revision >= 1
                    && has("plan_rank")
                    && op.fields.keys().all(|key| moves.contains(&key.as_str()))
            }
            Action::Delete => op.fields.is_empty(),
        };
        if !fields_ok || !rule {
            return Err(INVALID);
        }
        valid.push(op);
    }
    Ok(valid)
}
fn id(value: &str) -> bool {
    value.len() == 26
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b.is_ascii_uppercase() && !b"ILOU".contains(&b)))
}
fn reference(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        (1..=64).contains(&s.len())
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}
fn text(value: &Value, min: usize, max: usize) -> bool {
    value
        .as_str()
        .is_some_and(|s| (min..=max).contains(&s.encode_utf16().count()))
}
fn one_of(value: &Value, options: &[&str]) -> bool {
    value.as_str().is_some_and(|s| options.contains(&s))
}
fn day(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 10
            && s.bytes().enumerate().all(|(i, b)| {
                if i == 4 || i == 7 {
                    b == b'-'
                } else {
                    b.is_ascii_digit()
                }
            })
    })
}
/// `None` for a key the kind does not have.
fn field(kind: Kind, key: &str, value: &Value) -> Option<bool> {
    const STATUS: [&str; 6] = [
        "planned",
        "in_progress",
        "in_review",
        "blocked",
        "done",
        "cancelled",
    ];
    const COLORS: [&str; 8] = [
        "gray", "red", "orange", "yellow", "green", "teal", "blue", "purple",
    ];
    Some(match (kind, key) {
        (Kind::Plan | Kind::Epic, "title") => text(value, 1, 500),
        (Kind::Plan | Kind::Epic, "description") => text(value, 0, 20_000),
        (Kind::Plan, "status") => one_of(value, &["open", "closed"]),
        (Kind::Plan, "due_on") => value.is_null() || day(value),
        (Kind::Epic, "plan_id") => value.is_null() || reference(value),
        (Kind::Epic, "plan_rank") => value.is_null() || text(value, 1, 64),
        (Kind::Epic, "canon_status") => one_of(value, &STATUS),
        (Kind::Epic, "assignee") => value.is_null() || text(value, 1, 200),
        (Kind::Tag, "name") => text(value, 1, 64),
        (Kind::Tag, "color") => one_of(value, &COLORS),
        (Kind::EpicTag, "epic_id" | "tag_id") | (Kind::Comment, "epic_id") => reference(value),
        (Kind::Comment, "body") => text(value, 1, 20_000),
        _ => return None,
    })
}
fn required(kind: Kind) -> &'static [&'static str] {
    match kind {
        Kind::Plan | Kind::Epic => &["title"],
        Kind::Tag => &["name", "color"],
        Kind::EpicTag => &["epic_id", "tag_id"],
        Kind::Comment => &["epic_id", "body"],
    }
}
fn actions(kind: Kind) -> &'static [Action] {
    use Action::{Append, Create, Delete, Move, Set};
    match kind {
        Kind::Plan | Kind::Tag => &[Create, Set, Delete],
        Kind::Epic => &[Create, Set, Move, Delete],
        Kind::EpicTag => &[Create, Delete],
        Kind::Comment => &[Append, Delete],
    }
}

pub(super) fn decide(
    entities: &mut HashMap<String, StoredEntity>,
    op: &Op,
) -> Option<(u64, Map<String, Value>)> {
    if matches!(op.action, Action::Create | Action::Append) {
        if entities.contains_key(&op.entity_id) {
            return None;
        }
        let mut data = match op.kind {
            Kind::Plan => json!({"description": "", "status": "open", "due_on": null}),
            Kind::Epic => json!({"plan_id": null, "plan_rank": null, "description": "", "canon_status": "planned", "assignee": null}),
            _ => json!({}),
        }.as_object().cloned().unwrap_or_default();
        data.extend(op.fields.clone());
        let field_rev = data.keys().map(|field| (field.clone(), 1)).collect();
        let entity = Entity {
            entity_id: op.entity_id.clone(),
            kind: op.kind,
            revision: 1,
            deleted: false,
            data: data.clone(),
        };
        entities.insert(op.entity_id.clone(), StoredEntity { entity, field_rev });
        return Some((1, data));
    }
    let row = entities.get_mut(&op.entity_id)?;
    if row.entity.kind != op.kind || row.entity.deleted {
        return None;
    }
    let revision = row.entity.revision + 1;
    if matches!(op.action, Action::Delete) {
        row.entity.deleted = true;
        row.entity.revision = revision;
        return Some((revision, Map::new()));
    }
    if op.base_revision > row.entity.revision
        || (op.base_revision < row.entity.revision
            && op.fields.keys().any(|field| {
                row.field_rev.get(field).copied().unwrap_or_default() > op.base_revision
            }))
    {
        return None;
    }
    row.entity.revision = revision;
    row.entity.data.extend(op.fields.clone());
    for field in op.fields.keys() {
        row.field_rev.insert(field.clone(), revision);
    }
    Some((revision, op.fields.clone()))
}
