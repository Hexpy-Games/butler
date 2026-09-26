use serde_json::{Map, Value, json};
use unicode_segmentation::UnicodeSegmentation;

use crate::conversation::PublicMemoryScope;

#[derive(Clone)]
pub(super) struct QueryArgs {
    pub(super) query: Option<String>,
    pub(super) terms: Vec<String>,
    pub(super) mode: String,
    pub(super) case_sensitive: bool,
    pub(super) role: Option<&'static str>,
    pub(super) latest: bool,
    pub(super) time: Option<(String, String)>,
    pub(super) limit: usize,
    pub(super) cursor: Option<String>,
    pub(super) scope: PublicMemoryScope,
    pub(super) filter_identity: Value,
}

pub(super) fn parse(
    args: &Value,
    current_session_id: &str,
    project_id: Option<&str>,
) -> Result<QueryArgs, &'static str> {
    let query = match args.get("query").filter(|value| value.is_string()) {
        None => None,
        Some(value) => Some(string(value, 2048, true)?.to_owned()),
    };
    let terms = strings(args.get("terms").filter(|value| value.is_array()), 16, 256)?;
    let mode = enum_value(
        args.get("match_mode"),
        "phrase",
        &["phrase", "any", "all"],
        "invalid_match_mode",
    )?;
    if query.is_some() && (!terms.is_empty() || mode != "phrase") {
        return Err("query_terms_conflict");
    }
    if mode != "phrase" && terms.is_empty() {
        return Err("terms_required");
    }
    if mode == "phrase" && !terms.is_empty() {
        return Err("terms_not_allowed");
    }
    let speaker = enum_value(
        args.get("speaker"),
        "any",
        &["any", "user", "butler"],
        "invalid_role_filter",
    )?;
    let event = enum_value(
        args.get("event_kind"),
        "any",
        &["any", "inbound", "outbound"],
        "invalid_role_filter",
    )?;
    if speaker == "user" && event == "outbound" || speaker == "butler" && event == "inbound" {
        return Err("contradictory_role_filter");
    }
    let role = if speaker == "user" || event == "inbound" {
        Some("user")
    } else if speaker == "butler" || event == "outbound" {
        Some("assistant")
    } else {
        None
    };
    let order = enum_value(
        args.get("order"),
        "earliest",
        &["earliest", "latest"],
        "invalid_order",
    )?;
    let limit = match args.get("limit").filter(|value| value.is_number()) {
        None => 10,
        Some(v) => {
            let n = v
                .as_f64()
                .filter(|n| n.is_finite() && n.fract() == 0.0 && (1.0..=50.0).contains(n))
                .ok_or("invalid_limit")?;
            n as usize
        }
    };
    let project_id = project_id.map(str::trim).filter(|value| !value.is_empty());
    let scope_kind = enum_value(
        args.get("scope"),
        if project_id.is_some() {
            "current_project"
        } else {
            "all_user_sessions"
        },
        &["current_session", "current_project", "all_user_sessions"],
        "invalid_scope_value",
    )?;
    let session_ids = strings(
        args.get("session_ids").filter(|value| value.is_array()),
        32,
        512,
    )?;
    let project_filter = enum_value(
        args.get("project_filter"),
        "any",
        &["any", "unassigned", "selected"],
        "invalid_project_filter",
    )?;
    let project_ids = strings(
        args.get("project_ids").filter(|value| value.is_array()),
        16,
        512,
    )?;
    if (project_filter == "selected") == project_ids.is_empty() {
        return Err("invalid_project_filter");
    }
    let time = match args.get("time").filter(|value| !value.is_null()) {
        None => None,
        Some(value) => {
            if value.get("basis").and_then(Value::as_str) != Some("conversation") {
                return Err("invalid_time");
            }
            let (from_ms, from) = timestamp(
                value
                    .get("from")
                    .and_then(Value::as_str)
                    .ok_or("invalid_time")?,
            )?;
            let (to_ms, to) = timestamp(
                value
                    .get("to")
                    .and_then(Value::as_str)
                    .ok_or("invalid_time")?,
            )?;
            if from_ms >= to_ms {
                return Err("invalid_time");
            }
            Some((from, to))
        }
    };
    let case_sensitive = args
        .get("case_sensitive")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let include_internal = args.get("include_internal") == Some(&Value::Bool(true));
    let scope = PublicMemoryScope {
        current_session_id: current_session_id.to_owned(),
        current_project_id: project_id.map(str::to_owned),
        kind: scope_kind.to_owned(),
        session_ids,
        project_filter: project_filter.to_owned(),
        project_ids,
        include_internal,
    };
    let cursor = args
        .get("cursor")
        .filter(|value| value.is_string())
        .map(|v| v.as_str().ok_or("invalid_cursor").map(str::to_owned))
        .transpose()?;
    let mut identity = Map::new();
    identity.insert(
        "query".into(),
        query.as_ref().map_or(Value::Null, |v| json!(v)),
    );
    identity.insert("terms".into(), json!(terms));
    identity.insert("matchMode".into(), json!(mode));
    identity.insert("caseSensitive".into(), json!(case_sensitive));
    identity.insert("speaker".into(), json!(speaker));
    identity.insert("eventKind".into(), json!(event));
    identity.insert("order".into(), json!(order));
    if let Some((from, to)) = &time {
        identity.insert(
            "time".into(),
            json!({"from":from,"to":to,"basis":"conversation"}),
        );
    }
    identity.insert("limit".into(), json!(limit));
    identity.insert("scope".into(), json!(scope_kind));
    identity.insert("currentSessionId".into(), json!(current_session_id));
    identity.insert("currentProjectId".into(), json!(project_id));
    identity.insert("sessionIds".into(), json!(scope.session_ids));
    identity.insert("projectFilter".into(), json!(project_filter));
    identity.insert("projectIds".into(), json!(scope.project_ids));
    identity.insert("includeInternal".into(), json!(include_internal));
    Ok(QueryArgs {
        query,
        terms,
        mode: mode.into(),
        case_sensitive,
        role,
        latest: order == "latest",
        time,
        limit,
        cursor,
        scope,
        filter_identity: Value::Object(identity),
    })
}

fn enum_value<'a>(
    value: Option<&'a Value>,
    fallback: &'a str,
    allowed: &[&str],
    error: &'static str,
) -> Result<&'a str, &'static str> {
    let value = value
        .filter(|v| !v.is_null())
        .map(|v| v.as_str().unwrap_or(""))
        .unwrap_or(fallback);
    allowed.contains(&value).then_some(value).ok_or(error)
}

fn string(value: &Value, max: usize, allow_empty: bool) -> Result<&str, &'static str> {
    let value = value.as_str().ok_or("invalid_string")?;
    if (!allow_empty && value.trim().is_empty())
        || UnicodeSegmentation::graphemes(value, true).count() > max
    {
        return Err("invalid_string");
    }
    Ok(value)
}

fn strings(value: Option<&Value>, max: usize, chars: usize) -> Result<Vec<String>, &'static str> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let array = value
        .as_array()
        .filter(|v| v.len() <= max)
        .ok_or("invalid_array")?;
    array
        .iter()
        .map(|v| string(v, chars, false).map(str::to_owned))
        .collect()
}

fn timestamp(value: &str) -> Result<(i64, String), &'static str> {
    let bytes = value.as_bytes();
    let prefix = bytes.len() >= 12
        && [0, 1, 2, 3, 5, 6, 8, 9]
            .into_iter()
            .all(|index| bytes[index].is_ascii_digit())
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T';
    let zone = value.ends_with('Z')
        || bytes.len() >= 6 && {
            let tail = &bytes[bytes.len() - 6..];
            (tail[0] == b'+' || tail[0] == b'-')
                && tail[1].is_ascii_digit()
                && tail[2].is_ascii_digit()
                && tail[3] == b':'
                && tail[4].is_ascii_digit()
                && tail[5].is_ascii_digit()
        };
    if !prefix || !zone {
        return Err("invalid_time");
    }
    let millis = crate::js_date::parse_date_millis(value, &|_| None).ok_or("invalid_time")?;
    let formatted = crate::js_date::format_iso_millis(millis).ok_or("invalid_time")?;
    Ok((millis, formatted))
}
