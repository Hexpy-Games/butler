use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use unicode_segmentation::UnicodeSegmentation;

use crate::{
    conversation::{ConversationOriginKind, PublicMemorySnapshot, decode_message_scalars},
    json,
};

use super::{
    ContextError, ContextResult, ResolvedMemorySource,
    args::{self, ReadArgs},
    store_error,
};

#[derive(Deserialize, Serialize)]
struct SourceCursor {
    schema: String,
    source_ref: String,
    source_hash: String,
    scope_hash: Option<String>,
    next_byte: i64,
}

pub(super) fn read_memory(
    source: &ResolvedMemorySource,
    parsed: &ReadArgs,
    source_ref: &str,
    input: &Value,
) -> ContextResult<Value> {
    if format!("{:x}", Sha256::digest(source.scalar.as_bytes())) != source.source_hash {
        return Err(ContextError::new(
            "source_changed",
            "Memory source scalar hash changed",
        ));
    }
    let Page {
        text,
        start,
        end,
        next_cursor,
        split_grapheme,
    } = paginate(
        &source.scalar,
        parsed,
        source_ref,
        &source.source_hash,
        input,
    )?;
    let mut result = json!({"ok":true,"status":if next_cursor.is_some(){"partial"}else{"complete"},"mode":"source",
        "source_ref":source_ref,"basis":source.basis,"source_kind":source.source_kind,
        "conversation_session_id":source.conversation_session_id,
        "conversation_message_id":source.conversation_message_id,
        "text":text,"byte_start":start,"byte_end":end,
        "source_hash":source.source_hash,"next_cursor":next_cursor,"diagnostics":[]});
    if split_grapheme {
        result["split_grapheme"] = json!(true);
    }
    Ok(result)
}

pub(super) fn read(
    snapshot: &PublicMemorySnapshot,
    parsed: &ReadArgs,
    source_ref: &str,
    input: &Value,
) -> ContextResult<Value> {
    let parts = source_ref.split(':').collect::<Vec<_>>();
    if parts.len() != 6
        || parts[0] != "conversation-source"
        || parts[1] != "v2"
        || parts[5].len() != 64
        || !parts[5]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(ContextError::new(
            "source_not_found",
            "Invalid canonical source handle",
        ));
    }
    let decode = |value: &str| {
        URL_SAFE_NO_PAD
            .decode(value)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
    };
    let (message_id, part_id, pointer) = (decode(parts[2]), decode(parts[3]), decode(parts[4]));
    let Some((message_id, part_id, pointer)) = message_id
        .zip(part_id)
        .zip(pointer)
        .map(|((a, b), c)| (a, b, c))
    else {
        return Err(ContextError::new(
            "source_not_found",
            "Invalid canonical source handle",
        ));
    };
    let message = snapshot
        .message(&message_id)
        .map_err(store_error)?
        .ok_or_else(|| ContextError::new("source_not_found", "Canonical message is unavailable"))?;
    let session = snapshot
        .session(&message.message.session_id)
        .map_err(store_error)?;
    let project = session
        .as_ref()
        .and_then(|session| session.project_id.as_deref());
    if !snapshot.permits(&parsed.scope, &message.message.session_id, project)
        || !parsed.scope.include_internal
            && !matches!(
                message.message.origin_kind,
                ConversationOriginKind::UserInput | ConversationOriginKind::AssistantPublic
            )
    {
        return Err(ContextError::new(
            "invalid_scope",
            "Canonical source is outside the authorized scope",
        ));
    }
    let scalar = decode_message_scalars(&message)
        .into_iter()
        .find(|item| item.part.id == part_id && item.pointer == pointer)
        .ok_or_else(|| {
            ContextError::new("source_not_found", "Canonical source scalar is unavailable")
        })?;
    if scalar.hash != parts[5] {
        return Err(ContextError::new(
            "source_changed",
            "Canonical scalar hash changed",
        ));
    }
    let Page {
        text,
        start,
        end,
        next_cursor,
        split_grapheme,
    } = paginate(scalar.text, parsed, source_ref, parts[5], input)?;
    let mut result = json!({"ok":true,"status":if next_cursor.is_some(){"partial"}else{"complete"},"mode":"source",
        "source_ref":source_ref,"basis":if message.message.role == crate::conversation::ConversationRole::User {"user_statement"} else {"assistant_statement"},
        "source_kind":"conversation","conversation_session_id":message.message.session_id,"conversation_message_id":message.message.id,
        "text":text,"byte_start":start,"byte_end":end,"source_hash":parts[5],"next_cursor":next_cursor,"diagnostics":[]});
    if split_grapheme {
        result["split_grapheme"] = json!(true);
    }
    Ok(result)
}

struct Page {
    text: String,
    start: usize,
    end: usize,
    next_cursor: Option<String>,
    split_grapheme: bool,
}

fn paginate(
    scalar: &str,
    parsed: &ReadArgs,
    source_ref: &str,
    source_hash: &str,
    input: &Value,
) -> ContextResult<Page> {
    let max_chars = args::integer(
        input.get("max_chars").filter(|value| value.is_number()),
        4000,
        256,
        16000,
    )?;
    let cursor: Option<SourceCursor> = input
        .get("cursor")
        .filter(|value| value.is_string())
        .map(|value| {
            let text = value
                .as_str()
                .ok_or_else(|| ContextError::new("invalid_cursor", "Invalid source cursor"))?;
            let bytes = URL_SAFE_NO_PAD
                .decode(text)
                .map_err(|_| ContextError::new("invalid_cursor", "Invalid source cursor"))?;
            let decoded: SourceCursor = serde_json::from_slice(&bytes)
                .map_err(|_| ContextError::new("invalid_cursor", "Invalid source cursor"))?;
            if decoded.schema != "butler.source-read-cursor.v2"
                || decoded.next_byte.unsigned_abs() > 9_007_199_254_740_991
            {
                return Err(ContextError::new("invalid_cursor", "Invalid source cursor"));
            }
            Ok(decoded)
        })
        .transpose()?;
    if cursor
        .as_ref()
        .is_some_and(|cursor| cursor.source_ref != source_ref || cursor.source_hash != source_hash)
    {
        return Err(ContextError::new(
            "source_changed",
            "Source cursor identifies a different scalar",
        ));
    }
    if cursor
        .as_ref()
        .is_some_and(|cursor| cursor.scope_hash.as_deref() != Some(parsed.scope_hash.as_str()))
    {
        return Err(ContextError::new(
            "stale_cursor",
            "Source cursor scope changed",
        ));
    }
    let requested_start = cursor.as_ref().map_or(0, |cursor| cursor.next_byte);
    let bytes = scalar.as_bytes();
    if requested_start < 0 || requested_start as u64 > bytes.len() as u64 {
        return Err(ContextError::new(
            "source_changed",
            "Source cursor position is outside the scalar",
        ));
    }
    let start = requested_start as usize;
    let remainder = String::from_utf8_lossy(&bytes[start..]);
    let mut text = String::new();
    let mut encoded_text_bytes = 11usize; // JSON.stringify({text:""})
    let mut end = start;
    let mut split_grapheme = false;
    for (index, grapheme) in UnicodeSegmentation::graphemes(remainder.as_ref(), true).enumerate() {
        if index >= max_chars {
            break;
        }
        let added =
            json::string_bytes(grapheme).map_err(|e| ContextError::new("json", e.to_string()))? - 2;
        if encoded_text_bytes + added > 20 * 1024 {
            if text.is_empty() {
                for scalar in grapheme.chars() {
                    let mut encoded = [0; 4];
                    let added = json::string_bytes(scalar.encode_utf8(&mut encoded))
                        .map_err(|e| ContextError::new("json", e.to_string()))?
                        - 2;
                    if encoded_text_bytes + added > 20 * 1024 {
                        break;
                    }
                    text.push(scalar);
                    encoded_text_bytes += added;
                    end = start + text.len();
                }
                split_grapheme = true;
            }
            break;
        }
        text.push_str(grapheme);
        encoded_text_bytes += added;
        end = start + text.len();
    }
    let next_cursor = if end < bytes.len() {
        let value = SourceCursor {
            schema: "butler.source-read-cursor.v2".into(),
            source_ref: source_ref.into(),
            source_hash: source_hash.into(),
            scope_hash: Some(parsed.scope_hash.clone()),
            next_byte: end as i64,
        };
        let json =
            json::stringify(&json!(value)).map_err(|e| ContextError::new("json", e.to_string()))?;
        Some(URL_SAFE_NO_PAD.encode(json.as_bytes()))
    } else {
        None
    };
    Ok(Page {
        text,
        start,
        end,
        next_cursor,
        split_grapheme,
    })
}
