use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{conversation::PublicMemoryScope, json};

#[derive(Clone)]
pub(super) struct ListArgs {
    pub(super) scope: PublicMemoryScope,
    pub(super) limit: usize,
    pub(super) preview_messages: usize,
    pub(super) include_archived: bool,
    pub(super) session_kind: String,
    pub(super) time: Option<(String, String)>,
    pub(super) filter_hash: String,
    pub(super) cursor: Option<ListCursor>,
}

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct ListCursor {
    pub(super) schema: String,
    pub(super) filter_hash: String,
    pub(super) revision: u64,
    pub(super) last_at: String,
    pub(super) session_id: String,
}

pub(super) fn parse(
    input: &Value,
    current_session: &str,
    project_id: Option<&str>,
) -> Result<ListArgs, &'static str> {
    let limit = integer(
        input.get("limit").filter(|value| value.is_number()),
        20,
        1,
        100,
    )?;
    let preview_messages = integer(
        input
            .get("preview_messages")
            .filter(|value| value.is_number()),
        2,
        1,
        6,
    )?;
    let session_ids = strings(
        input.get("session_ids").filter(|value| value.is_array()),
        32,
    )?;
    let project_ids = strings(
        input.get("project_ids").filter(|value| value.is_array()),
        16,
    )?;
    let project_filter = match input.get("project_filter") {
        None | Some(Value::Null) => "any",
        Some(value) => value.as_str().unwrap_or(""),
    };
    if !["any", "unassigned", "selected"].contains(&project_filter)
        || (project_filter == "selected") == project_ids.is_empty()
    {
        return Err("invalid_project_filter");
    }
    let scope = match input.get("scope") {
        None | Some(Value::Null) => {
            if project_id.is_some() {
                "current_project"
            } else {
                "all_user_sessions"
            }
        }
        Some(value) => value.as_str().unwrap_or(""),
    };
    if !["current_session", "current_project", "all_user_sessions"].contains(&scope) {
        return Err("invalid_scope_value");
    }
    let session_kind = match input.get("session_kind") {
        None | Some(Value::Null) => "any",
        Some(value) => value.as_str().unwrap_or(""),
    };
    if !["any", "chat", "project", "unknown"].contains(&session_kind) {
        return Err("invalid_session_kind");
    }
    let time = match input.get("time") {
        None | Some(Value::Null) | Some(Value::Bool(false)) => None,
        Some(Value::Number(number)) if number.as_f64() == Some(0.0) => None,
        Some(Value::String(value)) if value.is_empty() => None,
        Some(value) => {
            if value.get("basis").and_then(Value::as_str) != Some("conversation") {
                return Err("invalid_time");
            }
            let from = iso(value
                .get("from")
                .and_then(Value::as_str)
                .ok_or("invalid_time")?)?;
            let to = iso(value
                .get("to")
                .and_then(Value::as_str)
                .ok_or("invalid_time")?)?;
            if from >= to {
                return Err("invalid_time");
            }
            Some((from, to))
        }
    };
    let include_internal = input.get("include_internal") == Some(&Value::Bool(true));
    let include_archived = input.get("include_archived") == Some(&Value::Bool(true));
    let filter = json!({"scope":scope,"sessionIds":session_ids,"projectFilter":project_filter,
        "projectIds":project_ids,"includeInternal":include_internal,"sessionKind":session_kind,
        "includeArchived":include_archived,"time":time.as_ref().map(|(from,to)| json!({"from":from,"to":to,"basis":"conversation"}))});
    let filter = if time.is_none() {
        let mut filter = filter;
        if let Some(object) = filter.as_object_mut() {
            object.shift_remove("time");
        }
        filter
    } else {
        filter
    };
    let text = json::stringify(&filter).map_err(|_| "invalid_arguments")?;
    let filter_hash = format!("{:x}", Sha256::digest(text.as_bytes()));
    let cursor = input
        .get("cursor")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .map(decode_cursor)
        .transpose()?;
    Ok(ListArgs {
        scope: PublicMemoryScope {
            current_session_id: current_session.into(),
            current_project_id: project_id.map(str::to_owned),
            kind: scope.into(),
            session_ids,
            project_filter: project_filter.into(),
            project_ids,
            include_internal,
        },
        limit,
        preview_messages,
        include_archived,
        session_kind: session_kind.into(),
        time,
        filter_hash,
        cursor,
    })
}

pub(super) fn encode_cursor(cursor: &ListCursor) -> String {
    // A derived struct of strings and numbers always serializes; an empty
    // cursor would be rejected as invalid on decode.
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(cursor).unwrap_or_default())
}
fn decode_cursor(text: &str) -> Result<ListCursor, &'static str> {
    let bytes = URL_SAFE_NO_PAD.decode(text).map_err(|_| "invalid_cursor")?;
    let cursor: ListCursor = serde_json::from_slice(&bytes).map_err(|_| "invalid_cursor")?;
    if cursor.schema != "butler.list-conversation-sessions-cursor.v2" {
        return Err("invalid_cursor");
    }
    Ok(cursor)
}
fn integer(
    value: Option<&Value>,
    fallback: usize,
    min: usize,
    max: usize,
) -> Result<usize, &'static str> {
    let Some(value) = value else {
        return Ok(fallback);
    };
    let Some(number) = value.as_f64() else {
        return Err("invalid_integer");
    };
    if number.fract() != 0.0 || !number.is_finite() || number < min as f64 || number > max as f64 {
        return Err("invalid_integer");
    }
    Ok(number as usize)
}
fn strings(value: Option<&Value>, max: usize) -> Result<Vec<String>, &'static str> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let Some(items) = value.as_array() else {
        return Err("invalid_array");
    };
    if items.len() > max {
        return Err("invalid_array");
    }
    items
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_owned)
                .ok_or("invalid_array")
        })
        .collect()
}
fn iso(text: &str) -> Result<String, &'static str> {
    let explicit = text.contains('T')
        && (text.ends_with('Z')
            || text
                .rfind(['+', '-'])
                .is_some_and(|index| index > 10 && text[index..].contains(':')));
    if !explicit {
        return Err("invalid_time");
    }
    let millis = crate::js_date::parse_date_millis(text, &|_| None).ok_or("invalid_time")?;
    DateTime::<Utc>::from_timestamp_millis(millis)
        .map(|date| date.to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or("invalid_time")
}
