//! MCP progressive catalog projection, schema descriptions, and stable ids.

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::client::{McpClientError, NativeMcpClient};

const MCP_DISABLED: &str = "MCP tool calls require the MCP tool profile in the current session";
const MCP_RECOVERY: &str =
    "Use a session with the MCP tool profile or choose an enabled native tool from tool_search.";
const MCP_SAFETY: &str =
    "Calls a configured MCP server tool; inspect schema and user intent first.";
const MCP_UNAVAILABLE_RECOVERY: &str = "Retry tool_describe later, choose another MCP server/tool, or continue with enabled native tools.";

pub(crate) async fn search(
    client: &NativeMcpClient,
    args: &Map<String, Value>,
    call_available: bool,
    signal: &CancellationToken,
) -> Result<Value, McpClientError> {
    let include_disabled_servers = args.get("include_disabled") == Some(&Value::Bool(true));
    let capabilities = Box::pin(client.list_capabilities(include_disabled_servers, signal)).await?;
    let include_disabled = args.get("include_disabled") != Some(&Value::Bool(false));
    let category = text(args, "category");
    let query = terms(text(args, "query"));
    let capability = terms(text(args, "capability"));
    let limit = args
        .get("limit")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map_or(20, |value| {
            crate::json::saturating_usize(value.floor()).clamp(1, 50)
        });
    let disabled_reason = (!call_available).then_some(MCP_DISABLED);
    let recovery_hint = disabled_reason.map(|_| MCP_RECOVERY);
    let mut ranked = Vec::new();

    for server in capabilities
        .get("servers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if server.get("ok") != Some(&Value::Bool(true)) {
            continue;
        }
        let namespace = server
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let display_name = server
            .get("display_name")
            .and_then(Value::as_str)
            .unwrap_or(namespace);
        for tool in server
            .get("tools")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(name) = tool
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
            else {
                continue;
            };
            let id = stable_id(namespace, name);
            let description = tool
                .get("description")
                .and_then(Value::as_str)
                .filter(|description| !description.trim().is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("MCP tool {name} from {display_name}."));
            let summary = summarize(&description);
            let tags = sorted_tags(&["mcp", "tool", "external", "server", namespace, display_name]);
            if !include_disabled && disabled_reason.is_some() {
                continue;
            }
            if category.is_some_and(|category| category != "mcp") {
                continue;
            }
            let query_score = score(name, &summary, &tags, &query, ScoreWeights::QUERY);
            let capability_score =
                score(name, &summary, &tags, &capability, ScoreWeights::CAPABILITY);
            if (!query.is_empty() && query_score == 0)
                || (!capability.is_empty() && capability_score == 0)
            {
                continue;
            }
            let schema = tool
                .get("input_schema")
                .filter(|schema| schema.is_object())
                .cloned()
                .unwrap_or_else(|| json!({}));
            let digest = schema_digest(&schema).map_err(|_| {
                super::client::failure(
                    "mcp_catalog_unavailable",
                    "MCP tool catalog could not be prepared.",
                    false,
                )
            })?;
            ranked.push((
                query_score + capability_score,
                id.clone(),
                json!({
                    "id":id,
                    "name":name,
                    "namespace":namespace,
                    "provider":"mcp",
                    "category":"mcp",
                    "summary":summary,
                    "tags":tags,
                    "risk_level":"high",
                    "enabled":call_available,
                    "disabled_reason":disabled_reason,
                    "recovery_hint":recovery_hint,
                    "schema_digest":digest,
                }),
            ));
        }
    }
    ranked.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| utf16_cmp(&left.1, &right.1))
    });
    Ok(json!({
        "ok":true,
        "results":ranked.into_iter().take(limit).map(|(_,_,entry)| entry).collect::<Vec<_>>(),
    }))
}

pub(crate) async fn describe(
    client: &NativeMcpClient,
    id: &str,
    server_id: &str,
    tool_name: &str,
    call_available: bool,
    signal: &CancellationToken,
) -> Result<Option<Value>, McpClientError> {
    if !call_available {
        return Ok(Some(disabled_description(
            id,
            server_id,
            tool_name,
            MCP_DISABLED,
            MCP_RECOVERY,
        )));
    }
    match Box::pin(client.describe_tool_schema(server_id, tool_name, signal)).await {
        Ok(Some(tool)) => {
            let schema = sanitize(
                tool.get("input_schema")
                    .filter(|schema| schema.is_object())
                    .unwrap_or(&Value::Null),
            );
            let digest = schema_digest(&schema).map_err(|_| {
                super::client::failure(
                    "mcp_catalog_unavailable",
                    "MCP tool description could not be prepared.",
                    false,
                )
            })?;
            Ok(Some(json!({
                "id":id,
                "name":tool.get("tool_name").and_then(Value::as_str).unwrap_or(tool_name),
                "namespace":tool.get("server_id").and_then(Value::as_str).unwrap_or(server_id),
                "provider":"mcp",
                "category":"mcp",
                "enabled":true,
                "disabled_reason":null,
                "recovery_hint":null,
                "safety_notes":[MCP_SAFETY],
                "schema":schema,
                "schema_digest":digest,
                "call_affordance":{"type":"mcp_tool","server_id":server_id,"tool_name":tool_name},
            })))
        }
        Ok(None) => Ok(None),
        Err(error) if error.code == "mcp_server_not_found" => Ok(None),
        Err(error) if error.code == "mcp_server_disabled" => Ok(Some(disabled_description(
            id,
            server_id,
            tool_name,
            &format!("MCP server is disabled: {server_id}"),
            "Choose an enabled MCP server/tool, or continue with enabled native tools.",
        ))),
        Err(error) if error.code == "turn_cancelled" => Err(error),
        Err(_) => Ok(Some(disabled_description(
            id,
            server_id,
            tool_name,
            "MCP server unavailable.",
            MCP_UNAVAILABLE_RECOVERY,
        ))),
    }
}

pub(crate) struct ParsedId {
    pub server_id: String,
    pub tool_name: String,
}

pub(crate) fn parse_id(id: &str) -> Option<ParsedId> {
    let mut parts = id.split(':');
    if parts.next()? != "mcp" {
        return None;
    }
    let server_id = decode_component(parts.next()?)?;
    let tool_name = decode_component(parts.next()?)?;
    if parts.next().is_some() || server_id.is_empty() || tool_name.is_empty() {
        return None;
    }
    Some(ParsedId {
        server_id,
        tool_name,
    })
}

fn disabled_description(
    id: &str,
    server_id: &str,
    tool_name: &str,
    reason: &str,
    recovery: &str,
) -> Value {
    json!({
        "id":id,
        "name":tool_name,
        "namespace":server_id,
        "provider":"mcp",
        "category":"mcp",
        "enabled":false,
        "disabled_reason":reason,
        "recovery_hint":recovery,
        "safety_notes":["MCP tools require explicit current-session MCP capability."],
        "schema":{},
        "schema_digest":schema_digest(&json!({})).unwrap_or_else(|_| "sha256:".into()),
        "call_affordance":{"type":"disabled","reason":reason},
    })
}

fn stable_id(namespace: &str, name: &str) -> String {
    format!(
        "mcp:{}:{}",
        encode_component(namespace.trim()),
        encode_component(name.trim())
    )
}

fn encode_component(value: &str) -> String {
    let mut result = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            result.push(byte as char);
        } else {
            result.push_str(&format!("%{byte:02X}"));
        }
    }
    result
}

fn decode_component(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = hex(*bytes.get(index + 1)?)?;
            let low = hex(*bytes.get(index + 2)?)?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn schema_digest(schema: &Value) -> Result<String, crate::json::JsonError> {
    let body = crate::json::stringify_sorted(schema, &|left, right| utf16_cmp(left, right))?;
    Ok(format!("sha256:{:x}", Sha256::digest(body.as_bytes())))
}

fn sanitize(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(sanitize).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, value)| {
                    let normalized = key
                        .to_ascii_lowercase()
                        .chars()
                        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
                        .collect::<String>();
                    let sensitive = matches!(
                        normalized.as_str(),
                        "default"
                            | "example"
                            | "examples"
                            | "secret"
                            | "token"
                            | "api_key"
                            | "apikey"
                            | "password"
                            | "authorization"
                    );
                    (
                        key.clone(),
                        if sensitive {
                            Value::String("[redacted]".into())
                        } else {
                            sanitize(value)
                        },
                    )
                })
                .collect(),
        ),
        scalar => scalar.clone(),
    }
}

fn terms(value: Option<&str>) -> Vec<String> {
    let mut terms = Vec::new();
    for term in value
        .unwrap_or("")
        .split(|ch: char| !ch.is_alphanumeric() && ch != '_' && ch != '-')
    {
        let term = term.trim().to_lowercase();
        if !term.is_empty() && !terms.contains(&term) {
            terms.push(term);
        }
    }
    terms
}

#[derive(Clone, Copy)]
struct ScoreWeights {
    exact_name: i32,
    tag: i32,
    category: i32,
    provider: i32,
    description: i32,
}

impl ScoreWeights {
    const QUERY: Self = Self {
        exact_name: 80,
        tag: 20,
        category: 16,
        provider: 10,
        description: 4,
    };
    const CAPABILITY: Self = Self {
        exact_name: 24,
        tag: 28,
        category: 20,
        provider: 8,
        description: 5,
    };
}

fn score(
    name: &str,
    summary: &str,
    tags: &[String],
    terms: &[String],
    weights: ScoreWeights,
) -> i32 {
    let mut score = 0;
    for term in terms {
        if name.eq_ignore_ascii_case(term) {
            score += weights.exact_name;
        }
        if name.to_lowercase().contains(term) {
            score += weights.exact_name / 2;
        }
        if "mcp" == term {
            score += weights.category + weights.provider;
        }
        if tags
            .iter()
            .any(|value| value.eq_ignore_ascii_case(term) || value.to_lowercase().contains(term))
        {
            score += weights.tag;
        }
        if summary.to_lowercase().contains(term) {
            score += weights.description;
        }
    }
    score
}

fn sorted_tags(values: &[&str]) -> Vec<String> {
    let mut tags = values
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    tags.sort_by(|left, right| utf16_cmp(left, right));
    tags.dedup();
    tags
}

fn summarize(value: &str) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.encode_utf16().count() <= 220 {
        return normalized;
    }
    let mut head = String::new();
    for ch in normalized.chars() {
        if head.encode_utf16().count() + ch.len_utf16() > 217 {
            break;
        }
        head.push(ch);
    }
    format!("{}...", head.trim_end())
}

fn text<'a>(args: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn utf16_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_ids_round_trip_encoded_segments() {
        let id = stable_id("server:one", "say hello/世界");
        let parsed = parse_id(&id).expect("MCP catalog id");
        assert_eq!(parsed.server_id, "server:one");
        assert_eq!(parsed.tool_name, "say hello/世界");
        assert!(parse_id("mcp:server:%GG").is_none());
    }

    #[test]
    fn schema_description_redacts_values_while_search_keeps_the_raw_schema_digest() {
        let raw = json!({"properties":{"token":{"default":"secret","type":"string"}}});
        let schema = sanitize(&raw);
        assert_eq!(schema["properties"]["token"], "[redacted]");
        assert_eq!(schema_digest(&schema).unwrap().len(), 71);
        assert_ne!(
            schema_digest(&raw).unwrap(),
            schema_digest(&schema).unwrap()
        );
    }
}
