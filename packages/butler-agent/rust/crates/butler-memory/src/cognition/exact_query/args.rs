//! The `query_memory` tool arguments: read as sent, then checked in the
//! order the public tool reports errors (text match, roles, order, limit,
//! scope, time, flags).

use crate::cognition::CognitionCode;
use serde::{Deserialize, Serialize};
use unicode_segmentation::UnicodeSegmentation;

use crate::lenient::{Arg, Obj};
use butler_turn::conversation::PublicMemoryScope;

/// The tool arguments, each kept as sent.
#[derive(Debug, Default, Deserialize)]
pub(super) struct QueryToolArgs {
    #[serde(default)]
    query: Arg<String>,
    #[serde(default)]
    terms: Arg<Vec<Arg<String>>>,
    #[serde(default)]
    match_mode: Arg<String>,
    #[serde(default)]
    speaker: Arg<String>,
    #[serde(default)]
    event_kind: Arg<String>,
    #[serde(default)]
    order: Arg<String>,
    #[serde(default)]
    limit: Arg<f64>,
    #[serde(default)]
    scope: Arg<String>,
    #[serde(default)]
    session_ids: Arg<Vec<Arg<String>>>,
    #[serde(default)]
    project_filter: Arg<String>,
    #[serde(default)]
    project_ids: Arg<Vec<Arg<String>>>,
    #[serde(default)]
    time: Arg<Obj<TimeArg>>,
    #[serde(default)]
    case_sensitive: Arg<bool>,
    #[serde(default)]
    include_internal: Arg<bool>,
    #[serde(default)]
    cursor: Arg<String>,
}

/// The `time` argument.
#[derive(Debug, Default, Deserialize)]
struct TimeArg {
    #[serde(default)]
    basis: Arg<String>,
    #[serde(default)]
    from: Arg<String>,
    #[serde(default)]
    to: Arg<String>,
}

/// How query terms must match a message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum MatchMode {
    /// The query (if any) appears as a phrase.
    Phrase,
    /// Any term appears.
    Any,
    /// Every term appears.
    All,
}

impl MatchMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Phrase => "phrase",
            Self::Any => "any",
            Self::All => "all",
        }
    }
}

/// Checked arguments of one query.
#[derive(Clone)]
pub(super) struct QueryArgs {
    pub(super) query: Option<String>,
    pub(super) terms: Vec<String>,
    pub(super) mode: MatchMode,
    pub(super) case_sensitive: bool,
    pub(super) role: Option<&'static str>,
    pub(super) latest: bool,
    pub(super) time: Option<(String, String)>,
    pub(super) limit: usize,
    pub(super) cursor: Option<String>,
    pub(super) scope: PublicMemoryScope,
    pub(super) filter_identity: FilterIdentity,
}

/// Everything that selects results; a cursor is valid only for the same
/// identity (hashed).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FilterIdentity {
    query: Option<String>,
    terms: Vec<String>,
    match_mode: &'static str,
    case_sensitive: bool,
    speaker: &'static str,
    event_kind: &'static str,
    order: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    time: Option<TimeIdentity>,
    limit: usize,
    scope: &'static str,
    current_session_id: String,
    current_project_id: Option<String>,
    session_ids: Vec<String>,
    project_filter: &'static str,
    project_ids: Vec<String>,
    include_internal: bool,
}

#[derive(Clone, Serialize)]
struct TimeIdentity {
    from: String,
    to: String,
    basis: &'static str,
}

/// The text-match arguments.
struct TextMatch {
    query: Option<String>,
    terms: Vec<String>,
    mode: MatchMode,
}

/// The speaker/event filter and the role it selects.
struct RoleFilter {
    speaker: &'static str,
    event: &'static str,
    role: Option<&'static str>,
}

pub(super) fn parse(
    args: &QueryToolArgs,
    current_session_id: &str,
    project_id: Option<&str>,
) -> Result<QueryArgs, CognitionCode> {
    let text = text_match(args)?;
    let roles = role_filter(args)?;
    let order = enum_value(
        &args.order,
        "earliest",
        &["earliest", "latest"],
        CognitionCode::InvalidOrder,
    )?;
    let limit = match &args.limit {
        Arg::Valid(n) => {
            if !(n.is_finite() && n.fract() == 0.0 && (1.0..=50.0).contains(n)) {
                return Err(CognitionCode::InvalidLimit);
            }
            butler_core::json::saturating_usize(*n)
        }
        Arg::Missing | Arg::Null | Arg::Invalid(_) => 10,
    };
    let project_id = project_id.map(str::trim).filter(|value| !value.is_empty());
    let (scope, scope_kind, project_filter) = scope(args, current_session_id, project_id)?;
    let time = time(&args.time)?;
    let case_sensitive = args.case_sensitive.valid().copied().unwrap_or(true);
    let filter_identity = FilterIdentity {
        query: text.query.clone(),
        terms: text.terms.clone(),
        match_mode: text.mode.as_str(),
        case_sensitive,
        speaker: roles.speaker,
        event_kind: roles.event,
        order,
        time: time.as_ref().map(|(from, to)| TimeIdentity {
            from: from.clone(),
            to: to.clone(),
            basis: "conversation",
        }),
        limit,
        scope: scope_kind,
        current_session_id: current_session_id.to_owned(),
        current_project_id: project_id.map(str::to_owned),
        session_ids: scope.session_ids.clone(),
        project_filter,
        project_ids: scope.project_ids.clone(),
        include_internal: scope.include_internal,
    };
    Ok(QueryArgs {
        query: text.query,
        terms: text.terms,
        mode: text.mode,
        case_sensitive,
        role: roles.role,
        latest: order == "latest",
        time,
        limit,
        cursor: args.cursor.valid().cloned(),
        scope,
        filter_identity,
    })
}

/// A phrase query, or terms matched any/all; not both.
fn text_match(args: &QueryToolArgs) -> Result<TextMatch, CognitionCode> {
    let query = args
        .query
        .valid()
        .map(|value| string(value, 2048, true).map(str::to_owned))
        .transpose()?;
    let terms = strings(&args.terms, 16, 256)?;
    let mode = match enum_value(
        &args.match_mode,
        "phrase",
        &["phrase", "any", "all"],
        CognitionCode::InvalidMatchMode,
    )? {
        "any" => MatchMode::Any,
        "all" => MatchMode::All,
        _ => MatchMode::Phrase,
    };
    if query.is_some() && (!terms.is_empty() || mode != MatchMode::Phrase) {
        return Err(CognitionCode::QueryTermsConflict);
    }
    if mode != MatchMode::Phrase && terms.is_empty() {
        return Err(CognitionCode::TermsRequired);
    }
    if mode == MatchMode::Phrase && !terms.is_empty() {
        return Err(CognitionCode::TermsNotAllowed);
    }
    Ok(TextMatch { query, terms, mode })
}

/// Speaker and event kind must agree; either selects user or assistant.
fn role_filter(args: &QueryToolArgs) -> Result<RoleFilter, CognitionCode> {
    let speaker = enum_value(
        &args.speaker,
        "any",
        &["any", "user", "butler"],
        CognitionCode::InvalidRoleFilter,
    )?;
    let event = enum_value(
        &args.event_kind,
        "any",
        &["any", "inbound", "outbound"],
        CognitionCode::InvalidRoleFilter,
    )?;
    if speaker == "user" && event == "outbound" || speaker == "butler" && event == "inbound" {
        return Err(CognitionCode::ContradictoryRoleFilter);
    }
    let role = if speaker == "user" || event == "inbound" {
        Some("user")
    } else if speaker == "butler" || event == "outbound" {
        Some("assistant")
    } else {
        None
    };
    Ok(RoleFilter {
        speaker,
        event,
        role,
    })
}

/// The conversation scope (current project by default when there is one);
/// `selected` project filtering needs project ids and only then allows them.
fn scope(
    args: &QueryToolArgs,
    current_session_id: &str,
    project_id: Option<&str>,
) -> Result<(PublicMemoryScope, &'static str, &'static str), CognitionCode> {
    let scope_kind = enum_value(
        &args.scope,
        if project_id.is_some() {
            "current_project"
        } else {
            "all_user_sessions"
        },
        &["current_session", "current_project", "all_user_sessions"],
        CognitionCode::InvalidScopeValue,
    )?;
    let session_ids = strings(&args.session_ids, 32, 512)?;
    let project_filter = enum_value(
        &args.project_filter,
        "any",
        &["any", "unassigned", "selected"],
        CognitionCode::InvalidProjectFilter,
    )?;
    let project_ids = strings(&args.project_ids, 16, 512)?;
    if (project_filter == "selected") == project_ids.is_empty() {
        return Err(CognitionCode::InvalidProjectFilter);
    }
    let scope = PublicMemoryScope {
        current_session_id: current_session_id.to_owned(),
        current_project_id: project_id.map(str::to_owned),
        kind: scope_kind.to_owned(),
        session_ids,
        project_filter: project_filter.to_owned(),
        project_ids,
        include_internal: args.include_internal == Arg::Valid(true),
    };
    Ok((scope, scope_kind, project_filter))
}

/// A conversation-time range `[from, to)` of ISO timestamps with a zone.
fn time(value: &Arg<Obj<TimeArg>>) -> Result<Option<(String, String)>, CognitionCode> {
    let time = match value {
        Arg::Missing | Arg::Null => return Ok(None),
        Arg::Valid(Obj(time)) => time,
        Arg::Invalid(_) => return Err(CognitionCode::InvalidTime),
    };
    if time.basis.valid().map(String::as_str) != Some("conversation") {
        return Err(CognitionCode::InvalidTime);
    }
    let (from_ms, from) = timestamp(time.from.valid().ok_or(CognitionCode::InvalidTime)?)?;
    let (to_ms, to) = timestamp(time.to.valid().ok_or(CognitionCode::InvalidTime)?)?;
    if from_ms >= to_ms {
        return Err(CognitionCode::InvalidTime);
    }
    Ok(Some((from, to)))
}

/// One of `allowed`, `fallback` when missing or `null`.
fn enum_value(
    value: &Arg<String>,
    fallback: &'static str,
    allowed: &[&'static str],
    error: CognitionCode,
) -> Result<&'static str, CognitionCode> {
    let value = match value {
        Arg::Missing | Arg::Null => fallback,
        Arg::Valid(value) => value.as_str(),
        Arg::Invalid(_) => "",
    };
    allowed
        .iter()
        .find(|allowed| **allowed == value)
        .copied()
        .ok_or(error)
}

fn string(value: &str, max: usize, allow_empty: bool) -> Result<&str, CognitionCode> {
    if (!allow_empty && value.trim().is_empty())
        || UnicodeSegmentation::graphemes(value, true).count() > max
    {
        return Err(CognitionCode::InvalidString);
    }
    Ok(value)
}

/// At most `max` non-blank strings of at most `chars` graphemes; a value
/// that is not an array reads as none.
fn strings(
    value: &Arg<Vec<Arg<String>>>,
    max: usize,
    chars: usize,
) -> Result<Vec<String>, CognitionCode> {
    let Arg::Valid(array) = value else {
        return Ok(Vec::new());
    };
    if array.len() > max {
        return Err(CognitionCode::InvalidArray);
    }
    array
        .iter()
        .map(|item| {
            let item = item.valid().ok_or(CognitionCode::InvalidString)?;
            string(item, chars, false).map(str::to_owned)
        })
        .collect()
}

/// A `YYYY-MM-DDT...` timestamp ending in `Z` or `±hh:mm`, and its
/// normalized ISO form.
fn timestamp(value: &str) -> Result<(i64, String), CognitionCode> {
    let bytes = value.as_bytes();
    let digit = |index: usize| bytes.get(index).is_some_and(u8::is_ascii_digit);
    let byte = |index: usize, expected: u8| bytes.get(index) == Some(&expected);
    let prefix = bytes.len() >= 12
        && [0, 1, 2, 3, 5, 6, 8, 9].into_iter().all(digit)
        && byte(4, b'-')
        && byte(7, b'-')
        && byte(10, b'T');
    let zone = value.ends_with('Z')
        || bytes.len() >= 6 && {
            let tail = bytes.len() - 6;
            (byte(tail, b'+') || byte(tail, b'-'))
                && digit(tail + 1)
                && digit(tail + 2)
                && byte(tail + 3, b':')
                && digit(tail + 4)
                && digit(tail + 5)
        };
    if !prefix || !zone {
        return Err(CognitionCode::InvalidTime);
    }
    let millis = butler_core::js_date::parse_date_millis(value, &|_| None)
        .ok_or(CognitionCode::InvalidTime)?;
    let formatted =
        butler_core::js_date::format_iso_millis(millis).ok_or(CognitionCode::InvalidTime)?;
    Ok((millis, formatted))
}
