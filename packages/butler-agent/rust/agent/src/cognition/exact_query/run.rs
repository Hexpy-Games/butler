use std::{
    path::Path,
    time::{Duration, Instant},
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;

use crate::{
    conversation::{CanonicalMemoryReadBinding, PublicMemorySnapshot, decode_message_scalars},
    json,
};

use super::{
    CognitionError, CognitionResult,
    args::{self, QueryArgs},
};

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

pub(super) fn query(
    path: &Path,
    binding: &CanonicalMemoryReadBinding,
    input: &Value,
) -> CognitionResult<Value> {
    let snapshot = match PublicMemorySnapshot::open(path, binding) {
        Ok(snapshot) => snapshot,
        Err(error) if error.code() == "invalid_scope" => return Ok(failure("invalid_scope", &[])),
        Err(_) => {
            return Ok(failure(
                "backend_unavailable",
                &["conversation_store_unavailable"],
            ));
        }
    };
    let args = match args::parse(
        input,
        &snapshot.current_session_id,
        binding.project_id.as_deref(),
    ) {
        Ok(args) => args,
        Err(error) => return Ok(failure("invalid_arguments", &[error])),
    };
    let result = run(&snapshot, &args);
    match result {
        Ok(result) => Ok(result),
        Err(error) if error.code == "invalid_cursor" => {
            Ok(failure("invalid_arguments", &["invalid_cursor"]))
        }
        Err(error) if error.code == "invalid_scope" || error.code == "stale_cursor" => {
            Ok(failure(error.code, &[]))
        }
        Err(_) => Ok(failure(
            "backend_unavailable",
            &["conversation_store_unavailable"],
        )),
    }
}

fn run(snapshot: &PublicMemorySnapshot, args: &QueryArgs) -> CognitionResult<Value> {
    let revision = snapshot.revision().map_err(store_error)?;
    let identity = json::stringify(&args.filter_identity)
        .map_err(|e| CognitionError::new("json", e.to_string()))?;
    let filter_hash = format!("{:x}", Sha256::digest(identity.as_bytes()));
    let cursor = args.cursor.as_deref().map(decode_cursor).transpose()?;
    if cursor
        .as_ref()
        .is_some_and(|c| c.filter_hash != filter_hash || c.revision != revision)
    {
        return Err(CognitionError::new(
            "stale_cursor",
            "Query cursor revision or filters changed",
        ));
    }
    if !snapshot.validate_scope(&args.scope).map_err(store_error)? {
        return Err(CognitionError::new(
            "invalid_scope",
            "Conversation scope is invalid",
        ));
    }
    let started = Instant::now();
    let mut inspected = 0;
    let mut matches = cursor.as_ref().map_or(0, |c| c.match_count);
    let mut last = cursor
        .as_ref()
        .map(|c| (c.created_at.clone(), c.message_id.clone()));
    let mut results: Vec<Value> = Vec::new();
    let mut keys: Vec<(String, String, usize)> = Vec::new();
    let mut complete = false;
    while inspected < MAX_SCAN && started.elapsed() < Duration::from_secs(5) {
        let rows = snapshot
            .message_page(
                &args.scope,
                args.role,
                args.time.as_ref().map(|(a, b)| (a.as_str(), b.as_str())),
                args.latest,
                last.as_ref().map(|(a, b)| (a.as_str(), b.as_str())),
                PAGE,
            )
            .map_err(store_error)?;
        if rows.is_empty() {
            complete = true;
            break;
        }
        let count = rows.len();
        let mut full_page = true;
        for row in rows {
            inspected += 1;
            last = Some((row.message.created_at.clone(), row.message.id.clone()));
            if let Some(scalar) = decode_message_scalars(&row)
                .into_iter()
                .find(|scalar| scalar_matches(scalar.text, args))
            {
                matches += 1;
                if results.len() < args.limit {
                    let source_ref = format!(
                        "conversation-source:v2:{}:{}:{}:{}",
                        URL_SAFE_NO_PAD.encode(row.message.id.as_bytes()),
                        URL_SAFE_NO_PAD.encode(scalar.part.id.as_bytes()),
                        URL_SAFE_NO_PAD.encode(scalar.pointer.as_bytes()),
                        scalar.hash
                    );
                    let mut read_args =
                        json!({"scope":args.scope.kind,"source_ref":source_ref,"max_chars":4000});
                    if !args.scope.session_ids.is_empty() {
                        read_args["session_ids"] = json!(args.scope.session_ids);
                    }
                    if args.scope.project_filter != "any" {
                        read_args["project_filter"] = json!(args.scope.project_filter);
                    }
                    if !args.scope.project_ids.is_empty() {
                        read_args["project_ids"] = json!(args.scope.project_ids);
                    }
                    if args.scope.include_internal {
                        read_args["include_internal"] = json!(true);
                    }
                    let excerpt = UnicodeSegmentation::graphemes(scalar.text, true)
                        .take(240)
                        .collect::<String>();
                    results.push(json!({"conversation_session_id":row.message.session_id,"conversation_message_id":row.message.id,
                        "source_ref":source_ref,"read_args":read_args,"created_at":row.message.created_at,
                        "speaker":if row.message.role == crate::conversation::ConversationRole::User {"user"} else {"butler"},
                        "excerpt":excerpt,"source":"conversation-store"}));
                    keys.push((
                        row.message.created_at.clone(),
                        row.message.id.clone(),
                        matches,
                    ));
                }
            }
            if results.len() >= args.limit {
                complete = snapshot
                    .message_page(
                        &args.scope,
                        args.role,
                        args.time.as_ref().map(|(a, b)| (a.as_str(), b.as_str())),
                        args.latest,
                        last.as_ref().map(|(a, b)| (a.as_str(), b.as_str())),
                        1,
                    )
                    .map_err(store_error)?
                    .is_empty();
                break;
            }
            if inspected >= MAX_SCAN || started.elapsed() >= Duration::from_secs(5) {
                full_page = false;
                break;
            }
        }
        if results.len() >= args.limit {
            break;
        }
        if full_page && count < PAGE {
            complete = true;
            break;
        }
    }
    let mut next = if complete {
        None
    } else {
        last.as_ref()
            .map(|(at, id)| {
                encode_cursor(&Cursor {
                    schema: "butler.query-memory-cursor.v2".into(),
                    filter_hash: filter_hash.clone(),
                    revision,
                    created_at: at.clone(),
                    message_id: id.clone(),
                    match_count: matches,
                })
            })
            .transpose()?
    };
    let mut diagnostics = if next.is_some() {
        vec![if started.elapsed() >= Duration::from_secs(5) {
            "operation_deadline"
        } else {
            "scan_continues"
        }]
    } else {
        Vec::new()
    };
    let mut output = response(&results, next.as_deref(), matches, &diagnostics);
    while !results.is_empty() && envelope_bytes(&output)? > 24 * 1024 {
        results.pop();
        keys.pop();
        next = if let Some((at, id, count)) = keys.last() {
            Some(encode_cursor(&Cursor {
                schema: "butler.query-memory-cursor.v2".into(),
                filter_hash: filter_hash.clone(),
                revision,
                created_at: at.clone(),
                message_id: id.clone(),
                match_count: *count,
            })?)
        } else {
            args.cursor
                .clone()
                .filter(|_| cursor.as_ref().is_some_and(|c| !c.message_id.is_empty()))
        };
        if !diagnostics.contains(&"serialization_budget") {
            diagnostics.push("serialization_budget");
        }
        output = response(&results, next.as_deref(), matches, &diagnostics);
        output["status"] = json!("partial");
        output["total_matches"] = Value::Null;
        output["count_status"] = json!("partial");
    }
    Ok(output)
}

fn response(results: &[Value], next: Option<&str>, count: usize, diagnostics: &[&str]) -> Value {
    json!({"ok":true,"status":if next.is_some(){"partial"}else{"complete"},"results":results,
        "returned":results.len(),"total_matches":if next.is_some(){Value::Null}else{json!(count)},
        "count_status":if next.is_some(){"partial"}else{"complete"},"next_cursor":next,"diagnostics":diagnostics})
}

fn scalar_matches(text: &str, args: &QueryArgs) -> bool {
    let normalize = |text: &str| {
        if args.case_sensitive {
            text.nfc().collect::<String>()
        } else {
            super::super::lexical::case_fold(&text.nfc().collect::<String>())
        }
    };
    let haystack = normalize(text);
    if args.mode == "phrase" {
        return args
            .query
            .as_ref()
            .is_none_or(|needle| haystack.contains(&normalize(needle)));
    }
    if args.mode == "all" {
        args.terms
            .iter()
            .all(|term| haystack.contains(&normalize(term)))
    } else {
        args.terms
            .iter()
            .any(|term| haystack.contains(&normalize(term)))
    }
}

fn decode_cursor(value: &str) -> CognitionResult<Cursor> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| CognitionError::new("invalid_cursor", "Malformed cursor"))?;
    let parsed: Cursor = serde_json::from_slice(&bytes)
        .map_err(|_| CognitionError::new("invalid_cursor", "Malformed cursor"))?;
    if parsed.schema != "butler.query-memory-cursor.v2" {
        return Err(CognitionError::new(
            "invalid_cursor",
            "Unexpected cursor schema",
        ));
    }
    Ok(parsed)
}
fn encode_cursor(value: &Cursor) -> CognitionResult<String> {
    let encoded =
        json::stringify(&json!(value)).map_err(|e| CognitionError::new("json", e.to_string()))?;
    Ok(URL_SAFE_NO_PAD.encode(encoded.as_bytes()))
}
fn envelope_bytes(value: &Value) -> CognitionResult<usize> {
    json::stringify(&json!({"ok":true,"output":value}))
        .map(|v| v.len())
        .map_err(|e| CognitionError::new("json", e.to_string()))
}
fn failure(code: &str, diagnostics: &[&str]) -> Value {
    json!({"ok":false,"code":code,"diagnostics":diagnostics})
}
#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn store_error(error: crate::conversation::ConversationError) -> CognitionError {
    CognitionError::new("store", error.to_string())
}
