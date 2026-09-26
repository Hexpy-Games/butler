use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::btcc::ModelRoundToolCall;
use crate::json::{CanonicalKeyOrder, canonical_json};
use crate::public_text::trim_js_whitespace;

use super::GuidedToolError;

pub(super) struct Occurrence {
    pub call_id: String,
    pub legacy_call_id: Option<String>,
    pub provider_call_id: Option<String>,
}

pub(super) fn occurrence(
    turn_id: &str,
    call_index: u64,
    call: &ModelRoundToolCall,
) -> Result<Occurrence, GuidedToolError> {
    let provider = trim_js_whitespace(&call.id);
    let provider = (!provider.is_empty()).then_some(provider);
    // Direct native read/write/edit calls do not use the progressive catalog
    // wrapper or run_command's presentation-only summary normalization.
    let catalog_id = (call.name == "tool_call")
        .then(|| call.arguments.get("id").and_then(Value::as_str))
        .flatten()
        .map(trim_js_whitespace)
        .filter(|id| !id.is_empty());
    let nested = catalog_id
        .and_then(|_| call.arguments.get("arguments"))
        .and_then(Value::as_object);
    let target = catalog_id
        .and_then(|id| {
            if crate::mcp_client::parse_mcp_catalog_id(id).is_some() {
                Some("call_mcp_tool")
            } else {
                id.split(':').nth(1)
            }
        })
        .filter(|name| !name.is_empty());
    let mut normalized = nested.cloned().unwrap_or_else(|| call.arguments.clone());
    let effective_name = if nested.is_some() {
        target.unwrap_or(&call.name)
    } else {
        &call.name
    };
    if effective_name == "run_command" {
        normalized.remove("summary");
    }
    let arguments = if catalog_id.is_some() {
        crate::json::stringify_sorted(&Value::Object(normalized), &|a, b| {
            a.encode_utf16().cmp(b.encode_utf16())
        })
    } else {
        canonical_json(&Value::Object(normalized), CanonicalKeyOrder::Utf16Lexical)
    }
    .map_err(|error| GuidedToolError::new("guided_tool_identity_json", error.to_string()))?;
    let identity_fields = if let Some(id) = catalog_id {
        format!("{id}\0{effective_name}\0{arguments}")
    } else {
        format!("{effective_name}\0{arguments}")
    };
    let identity = if let Some(provider) = provider {
        [
            "btcc-guided-provider-tool-call.v2",
            turn_id,
            provider,
            &identity_fields,
        ]
        .join("\0")
    } else {
        let index = call_index.to_string();
        [
            "btcc-guided-tool-call.v1",
            turn_id,
            &index,
            &identity_fields,
        ]
        .join("\0")
    };
    let legacy_arguments = if provider.is_some() {
        Some(
            canonical_json(
                &Value::Object(call.arguments.clone()),
                CanonicalKeyOrder::Utf16Lexical,
            )
            .map_err(|error| {
                GuidedToolError::new("guided_tool_identity_json", error.to_string())
            })?,
        )
    } else {
        None
    };
    let legacy_call_id = provider.map(|provider| {
        hash(
            &[
                "btcc-guided-provider-tool-call.v1",
                turn_id,
                provider,
                &call.name,
                legacy_arguments.as_deref().unwrap_or_default(),
            ]
            .join("\0"),
        )
    });
    Ok(Occurrence {
        call_id: hash(&identity),
        legacy_call_id,
        provider_call_id: provider.map(str::to_owned),
    })
}

fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
