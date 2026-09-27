use std::{
    path::Path,
    time::{Duration, Instant},
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;

use butler_turn::conversation::{
    CanonicalMemoryReadBinding, PublicMemorySnapshot, decode_message_scalars,
};

use super::{
    CognitionError, CognitionResult,
    args::{self, MatchMode, QueryArgs},
};
use crate::cognition::CognitionCode;

const PAGE: usize = 1_000;
const MAX_SCAN: usize = 50_000;

#[derive(Deserialize, Serialize)]
struct Cursor {
    schema: String,
    filter_hash: String,
    revision: u64,
    created_at: String,
    message_id: String,
    match_count: usize,
}

/// One matching message scalar.
#[derive(Serialize)]
struct QueryHit {
    conversation_session_id: String,
    conversation_message_id: String,
    source_ref: String,
    read_args: ReadArgs,
    created_at: String,
    speaker: &'static str,
    excerpt: String,
    source: &'static str,
}

/// `read_memory_source` arguments that reopen a hit in the same scope.
#[derive(Serialize)]
struct ReadArgs {
    scope: String,
    source_ref: String,
    max_chars: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_filter: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    include_internal: Option<bool>,
}

/// The tool result.
#[derive(Serialize)]
struct QueryResponse<'a> {
    ok: bool,
    status: &'static str,
    results: &'a [QueryHit],
    returned: usize,
    total_matches: Option<usize>,
    count_status: &'static str,
    next_cursor: Option<&'a str>,
    diagnostics: &'a [&'static str],
}

/// A tool failure.
#[derive(Serialize)]
struct QueryFailure<'a> {
    ok: bool,
    code: &'a str,
    diagnostics: &'a [&'a str],
}

/// What a scan found before its page, scan or time budget ran out.
struct Scan {
    results: Vec<QueryHit>,
    /// `(created_at, message_id, match count)` after each kept hit.
    keys: Vec<(String, String, usize)>,
    matches: usize,
    last: Option<(String, String)>,
    complete: bool,
    started: Instant,
}

pub(super) fn query(
    path: &Path,
    binding: &CanonicalMemoryReadBinding,
    input: &args::QueryToolArgs,
) -> CognitionResult<Value> {
    let snapshot = match PublicMemorySnapshot::open(path, binding) {
        Ok(snapshot) => snapshot,
        Err(error) if error.code() == "invalid_scope" => return failure("invalid_scope", &[]),
        Err(_) => return failure("backend_unavailable", &["conversation_store_unavailable"]),
    };
    let args = match args::parse(
        input,
        &snapshot.current_session_id,
        binding.project_id.as_deref(),
    ) {
        Ok(args) => args,
        Err(error) => return failure("invalid_arguments", &[error.as_str()]),
    };
    match run(&snapshot, &args) {
        Ok(result) => Ok(result),
        Err(error) if error.code() == "invalid_cursor" => {
            failure("invalid_arguments", &["invalid_cursor"])
        }
        Err(error) if error.code() == "invalid_scope" || error.code() == "stale_cursor" => {
            failure(error.code(), &[])
        }
        Err(_) => failure("backend_unavailable", &["conversation_store_unavailable"]),
    }
}

/// Scans matching messages after the cursor (a stale cursor is refused),
/// then trims the page to the envelope budget.
fn run(snapshot: &PublicMemorySnapshot, args: &QueryArgs) -> CognitionResult<Value> {
    let revision = snapshot.revision().map_err(store_error)?;
    let identity = crate::js_json::stringify(&args.filter_identity)
        .map_err(|e| CognitionError::new(CognitionCode::Json, e.to_string()).with_source(e))?;
    let filter_hash = format!("{:x}", Sha256::digest(identity.as_bytes()));
    let cursor = args.cursor.as_deref().map(decode_cursor).transpose()?;
    if cursor
        .as_ref()
        .is_some_and(|c| c.filter_hash != filter_hash || c.revision != revision)
    {
        return Err(CognitionError::new(
            CognitionCode::StaleCursor,
            "Query cursor revision or filters changed",
        ));
    }
    if !snapshot.validate_scope(&args.scope).map_err(store_error)? {
        return Err(CognitionError::new(
            CognitionCode::InvalidScope,
            "Conversation scope is invalid",
        ));
    }
    let mut scan = scan(snapshot, args, cursor.as_ref())?;
    let make_cursor = |(at, id, count): (&String, &String, usize)| {
        encode_cursor(&Cursor {
            schema: "butler.query-memory-cursor.v2".into(),
            filter_hash: filter_hash.clone(),
            revision,
            created_at: at.clone(),
            message_id: id.clone(),
            match_count: count,
        })
    };
    let mut next = if scan.complete {
        None
    } else {
        scan.last
            .as_ref()
            .map(|(at, id)| make_cursor((at, id, scan.matches)))
            .transpose()?
    };
    let mut diagnostics = if next.is_some() {
        vec![if scan.started.elapsed() >= Duration::from_secs(5) {
            "operation_deadline"
        } else {
            "scan_continues"
        }]
    } else {
        Vec::new()
    };
    let mut trimmed = false;
    while !scan.results.is_empty()
        && envelope_bytes(&response(
            &scan.results,
            next.as_deref(),
            scan.matches,
            &diagnostics,
            trimmed,
        ))? > 24 * 1024
    {
        scan.results.pop();
        scan.keys.pop();
        next = if let Some((at, id, count)) = scan.keys.last() {
            Some(make_cursor((at, id, *count))?)
        } else {
            args.cursor
                .clone()
                .filter(|_| cursor.as_ref().is_some_and(|c| !c.message_id.is_empty()))
        };
        if !diagnostics.contains(&"serialization_budget") {
            diagnostics.push("serialization_budget");
        }
        trimmed = true;
    }
    encode(&response(
        &scan.results,
        next.as_deref(),
        scan.matches,
        &diagnostics,
        trimmed,
    ))
}

/// Pages through messages after `cursor` (1000 per page, at most 50 000
/// messages or 5 s), keeping the first `limit` hits.
fn scan(
    snapshot: &PublicMemorySnapshot,
    args: &QueryArgs,
    cursor: Option<&Cursor>,
) -> CognitionResult<Scan> {
    let mut scan = Scan {
        results: Vec::new(),
        keys: Vec::new(),
        matches: cursor.map_or(0, |c| c.match_count),
        last: cursor.map(|c| (c.created_at.clone(), c.message_id.clone())),
        complete: false,
        started: Instant::now(),
    };
    let mut inspected = 0;
    let page = |last: Option<&(String, String)>, size: usize| {
        snapshot
            .message_page(
                &args.scope,
                args.role,
                args.time.as_ref().map(|(a, b)| (a.as_str(), b.as_str())),
                args.latest,
                last.map(|(a, b)| (a.as_str(), b.as_str())),
                size,
            )
            .map_err(store_error)
    };
    while inspected < MAX_SCAN && scan.started.elapsed() < Duration::from_secs(5) {
        let rows = page(scan.last.as_ref(), PAGE)?;
        if rows.is_empty() {
            scan.complete = true;
            break;
        }
        let count = rows.len();
        let mut full_page = true;
        for row in rows {
            inspected += 1;
            scan.last = Some((row.message.created_at.clone(), row.message.id.clone()));
            if let Some(scalar) = decode_message_scalars(&row)
                .into_iter()
                .find(|scalar| scalar_matches(scalar.text, args))
            {
                scan.matches += 1;
                if scan.results.len() < args.limit {
                    scan.results.push(hit(&row, &scalar, args));
                    scan.keys.push((
                        row.message.created_at.clone(),
                        row.message.id.clone(),
                        scan.matches,
                    ));
                }
            }
            if scan.results.len() >= args.limit {
                scan.complete = page(scan.last.as_ref(), 1)?.is_empty();
                break;
            }
            if inspected >= MAX_SCAN || scan.started.elapsed() >= Duration::from_secs(5) {
                full_page = false;
                break;
            }
        }
        if scan.results.len() >= args.limit {
            break;
        }
        if full_page && count < PAGE {
            scan.complete = true;
            break;
        }
    }
    Ok(scan)
}

/// A hit with a source ref naming the exact scalar and its hash.
fn hit(
    row: &butler_turn::conversation::ConversationMessageWithParts,
    scalar: &butler_turn::conversation::ConversationScalar<'_>,
    args: &QueryArgs,
) -> QueryHit {
    let source_ref = format!(
        "conversation-source:v2:{}:{}:{}:{}",
        URL_SAFE_NO_PAD.encode(row.message.id.as_bytes()),
        URL_SAFE_NO_PAD.encode(scalar.part.id.as_bytes()),
        URL_SAFE_NO_PAD.encode(scalar.pointer.as_bytes()),
        scalar.hash
    );
    let scope = &args.scope;
    QueryHit {
        conversation_session_id: row.message.session_id.clone(),
        conversation_message_id: row.message.id.clone(),
        read_args: ReadArgs {
            scope: scope.kind.clone(),
            source_ref: source_ref.clone(),
            max_chars: 4000,
            session_ids: (!scope.session_ids.is_empty()).then(|| scope.session_ids.clone()),
            project_filter: (scope.project_filter != "any").then(|| scope.project_filter.clone()),
            project_ids: (!scope.project_ids.is_empty()).then(|| scope.project_ids.clone()),
            include_internal: scope.include_internal.then_some(true),
        },
        source_ref,
        created_at: row.message.created_at.clone(),
        speaker: if row.message.role == butler_turn::conversation::ConversationRole::User {
            "user"
        } else {
            "butler"
        },
        excerpt: UnicodeSegmentation::graphemes(scalar.text, true)
            .take(240)
            .collect(),
        source: "conversation-store",
    }
}

/// The page; a page trimmed to the envelope budget is always partial with
/// an unknown total.
fn response<'a>(
    results: &'a [QueryHit],
    next: Option<&'a str>,
    count: usize,
    diagnostics: &'a [&'static str],
    trimmed: bool,
) -> QueryResponse<'a> {
    let partial = trimmed || next.is_some();
    QueryResponse {
        ok: true,
        status: if partial { "partial" } else { "complete" },
        results,
        returned: results.len(),
        total_matches: (!partial).then_some(count),
        count_status: if partial { "partial" } else { "complete" },
        next_cursor: next,
        diagnostics,
    }
}

/// Whether the (NFC, optionally case-folded) text contains the phrase, or
/// any/all of the terms.
fn scalar_matches(text: &str, args: &QueryArgs) -> bool {
    let normalize = |text: &str| {
        if args.case_sensitive {
            text.nfc().collect::<String>()
        } else {
            super::super::lexical::case_fold(&text.nfc().collect::<String>())
        }
    };
    let haystack = normalize(text);
    match args.mode {
        MatchMode::Phrase => args
            .query
            .as_ref()
            .is_none_or(|needle| haystack.contains(&normalize(needle))),
        MatchMode::All => args
            .terms
            .iter()
            .all(|term| haystack.contains(&normalize(term))),
        MatchMode::Any => args
            .terms
            .iter()
            .any(|term| haystack.contains(&normalize(term))),
    }
}

fn decode_cursor(value: &str) -> CognitionResult<Cursor> {
    let bytes = URL_SAFE_NO_PAD.decode(value).map_err(|source| {
        CognitionError::new(CognitionCode::InvalidCursor, "Malformed cursor").with_source(source)
    })?;
    let parsed: Cursor = serde_json::from_slice(&bytes).map_err(|source| {
        CognitionError::new(CognitionCode::InvalidCursor, "Malformed cursor").with_source(source)
    })?;
    if parsed.schema != "butler.query-memory-cursor.v2" {
        return Err(CognitionError::new(
            CognitionCode::InvalidCursor,
            "Unexpected cursor schema",
        ));
    }
    Ok(parsed)
}
fn encode_cursor(value: &Cursor) -> CognitionResult<String> {
    let encoded = crate::js_json::stringify(value)
        .map_err(|e| CognitionError::new(CognitionCode::Json, e.to_string()).with_source(e))?;
    Ok(URL_SAFE_NO_PAD.encode(encoded.as_bytes()))
}
/// Bytes of the page inside the tool envelope `{"ok":true,"output":..}`.
fn envelope_bytes(response: &QueryResponse<'_>) -> CognitionResult<usize> {
    #[derive(Serialize)]
    struct Envelope<'a, 'b> {
        ok: bool,
        output: &'a QueryResponse<'b>,
    }
    crate::js_json::stringify(&Envelope {
        ok: true,
        output: response,
    })
    .map(|v| v.len())
    .map_err(|e| CognitionError::new(CognitionCode::Json, e.to_string()).with_source(e))
}
fn failure(code: &str, diagnostics: &[&str]) -> CognitionResult<Value> {
    encode(&QueryFailure {
        ok: false,
        code,
        diagnostics,
    })
}
fn encode(value: &impl Serialize) -> CognitionResult<Value> {
    serde_json::to_value(value)
        .map_err(|e| CognitionError::new(CognitionCode::Json, e.to_string()).with_source(e))
}
#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn store_error(error: butler_turn::conversation::ConversationError) -> CognitionError {
    CognitionError::new(CognitionCode::Store, error.to_string())
}
