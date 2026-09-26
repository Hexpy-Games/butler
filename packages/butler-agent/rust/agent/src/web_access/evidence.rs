use std::collections::HashSet;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use url::Url;

use super::search::SearchResult;

pub(super) fn search_items(results: &[SearchResult], observed_at: &str) -> Vec<Value> {
    results
        .iter()
        .filter_map(|result| {
            let source_url = normalized_http_url(&result.url)?;
            let bounded = bounded_text(
                &[
                    result.title.trim(),
                    result.snippet.trim(),
                    result.source.trim(),
                ]
                .into_iter()
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join("\n"),
                1_200,
            );
            (!bounded.0.is_empty()).then(|| {
                public_item(
                    "web_search",
                    &source_url,
                    observed_at,
                    None,
                    "search_snippet",
                    &bounded.0,
                    &[
                        "Search-result text is a provider-supplied excerpt and may omit source context.".into(),
                        if bounded.1 {
                            "The search-result excerpt was truncated to the evidence bound.".into()
                        } else {
                            String::new()
                        },
                    ],
                )
            })
        })
        .collect()
}

pub(super) fn read_items(
    source_url: &str,
    markdown: &str,
    chunks: &[Value],
    observed_at: &str,
    evidence_quality: &str,
    truncated: bool,
    warnings: &[String],
) -> Vec<Value> {
    let Some(fallback_url) = normalized_http_url(source_url) else {
        return Vec::new();
    };
    let shared = shared_limitations(evidence_quality, truncated, warnings);
    let projected = chunks
        .iter()
        .filter_map(|chunk| {
            let title = chunk
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            let text = chunk
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            let content = [title, text]
                .into_iter()
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            let (bounded, clipped) = bounded_text(&content, 1_500);
            if bounded.is_empty() {
                return None;
            }
            let url = chunk
                .get("url")
                .and_then(Value::as_str)
                .and_then(normalized_http_url)
                .unwrap_or_else(|| fallback_url.clone());
            let mut limitations = shared.clone();
            if clipped {
                limitations.push("The page chunk was truncated to the evidence bound.".into());
            }
            Some(public_item(
                "web_read",
                &url,
                observed_at,
                None,
                "page_chunk",
                &bounded,
                &limitations,
            ))
        })
        .take(8)
        .collect::<Vec<_>>();
    if !projected.is_empty() {
        return projected;
    }
    let (bounded, clipped) = bounded_text(markdown.trim(), 4_000);
    if bounded.is_empty() {
        return Vec::new();
    }
    let mut limitations = shared;
    if clipped {
        limitations.push("The page excerpt was truncated to the evidence bound.".into());
    }
    vec![public_item(
        "web_read",
        &fallback_url,
        observed_at,
        None,
        "page_excerpt",
        &bounded,
        &limitations,
    )]
}

pub(super) struct CapabilityReceiptInput<'a> {
    pub(super) producer: &'a str,
    pub(super) capability: &'a str,
    pub(super) evidence_kind: &'a str,
    pub(super) maturity: &'a str,
    pub(super) verified: bool,
    pub(super) confidence: f64,
    pub(super) summary: &'a str,
    pub(super) references: Vec<Value>,
    pub(super) limitations: Vec<String>,
    pub(super) created_at: &'a str,
}

pub(super) fn search_capability_receipt(results: &[SearchResult], observed_at: &str) -> Value {
    capability_receipt(CapabilityReceiptInput {
        producer: "web_search",
        capability: "source_candidate",
        evidence_kind: "source_candidate",
        maturity: "candidate",
        verified: false,
        confidence: if results.is_empty() { 0.15 } else { 0.45 },
        summary: if results.is_empty() {
            "Search completed without public source candidates."
        } else {
            "Search returned public source candidates for later verification."
        },
        references: results
            .iter()
            .filter_map(|result| normalized_http_url(&result.url).map(|url| json!({"url":url})))
            .collect(),
        limitations: vec!["Search candidate discovery is not source verification.".into()],
        created_at: observed_at,
    })
}

pub(super) fn read_capability_receipt(
    ok: bool,
    source_url: &str,
    evidence_quality: &str,
    truncated: bool,
    error: Option<&str>,
    observed_at: &str,
) -> Value {
    let references = normalized_http_url(source_url)
        .map(|url| vec![json!({"url":url})])
        .unwrap_or_default();
    if ok {
        let mut limitations = Vec::new();
        if evidence_quality == "limited" {
            limitations.push("Page evidence is limited.".to_owned());
        }
        if truncated {
            limitations.push("Page evidence was truncated to fit the runtime bound.".to_owned());
        }
        capability_receipt(CapabilityReceiptInput {
            producer: "web_read",
            capability: "source_verified",
            evidence_kind: "source_page",
            maturity: "verified",
            verified: true,
            confidence: if evidence_quality == "good" { 0.9 } else { 0.7 },
            summary: "A public source page was read and bounded page evidence was returned.",
            references,
            limitations,
            created_at: observed_at,
        })
    } else {
        capability_receipt(CapabilityReceiptInput {
            producer: "web_read",
            capability: "limitation_recorded",
            evidence_kind: "limitation",
            maturity: "rejected",
            verified: false,
            confidence: 0.2,
            summary: "A public source page read was attempted but did not produce verified page evidence.",
            references,
            limitations: vec![
                error
                    .unwrap_or("Source page evidence was unavailable.")
                    .to_owned(),
            ],
            created_at: observed_at,
        })
    }
}

pub(super) struct ToolReceiptInput<'a> {
    pub(super) tool: &'a str,
    pub(super) receipt_type: &'a str,
    pub(super) summary: &'a str,
    pub(super) verified: bool,
    pub(super) covers: &'a [&'a str],
    pub(super) satisfies: &'a [&'a str],
    pub(super) urls: &'a [String],
    pub(super) metrics: Value,
}

pub(super) fn tool_receipt(input: &ToolReceiptInput<'_>) -> Value {
    let references = input
        .urls
        .iter()
        .filter_map(|url| normalized_http_url(url))
        .take(12)
        .map(|url| json!({"kind":"url","ref":url}))
        .collect::<Vec<_>>();
    let mut receipt = json!({
        "schema":"butler.evidence-receipt.v1",
        "id":format!("receipt-{}", &uuid::Uuid::new_v4().to_string()[..12]),
        "producer":{"kind":"tool","name":input.tool},
        "receiptType":input.receipt_type,
        "verified":input.verified,
        "covers":input.covers,
        "summary":input.summary,
        "references":references,
        "metrics":input.metrics,
    });
    if !input.satisfies.is_empty() {
        receipt["satisfies"] = json!(input.satisfies);
    }
    receipt
}

pub(super) fn capability_receipt(input: CapabilityReceiptInput<'_>) -> Value {
    let mut receipt = json!({
        "receipt_id":format!("ecr-{}", &uuid::Uuid::new_v4().to_string()[..12]),
        "schema_version":"evidence-capability.v1",
        "producer":{"kind":"tool","name":input.producer},
        "capability":input.capability,
        "evidence_kind":input.evidence_kind,
        "maturity":input.maturity,
        "confidence":input.confidence,
        "verified":input.verified,
        "summary":input.summary,
        "references":input.references,
        "limitations":unique_limitations(input.limitations),
        "created_at":input.created_at,
    });
    if input.verified {
        receipt["satisfies"] = json!([input.capability]);
    }
    receipt
}

pub(super) fn public_item(
    producer: &str,
    source_url: &str,
    observed_at: &str,
    published_at: Option<&str>,
    content_kind: &str,
    bounded_content: &str,
    limitations: &[String],
) -> Value {
    let identity = source_identity(source_url);
    let id_input = format!("{producer}\n{source_url}\n{content_kind}\n{bounded_content}");
    let hash = Sha256::digest(id_input.as_bytes());
    let limitations = unique_limitations(limitations.iter().cloned());
    json!({
        "schema_version":"butler.public-web-evidence-item.v1",
        "evidence_item_id":format!("public-web-{}", hex_prefix(&hash, 24)),
        "producer":producer,
        "source_url":source_url,
        "source_identity":identity,
        "observed_at":observed_at,
        "published_at":published_at,
        "content_kind":content_kind,
        "bounded_content":bounded_content,
        "limitations":limitations,
    })
}

pub(super) fn normalized_http_url(value: &str) -> Option<String> {
    let mut url = Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    url.set_fragment(None);
    Some(url.to_string())
}

pub(super) fn source_identity(value: &str) -> String {
    Url::parse(value)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .map(|host| host.strip_prefix("www.").unwrap_or(&host).to_owned())
        .unwrap_or_default()
}

pub(super) fn bounded_text(value: &str, max_chars: usize) -> (String, bool) {
    if value.encode_utf16().count() <= max_chars {
        return (value.to_owned(), false);
    }
    let clipped = crate::json::Utf16Slice::new(value, 0, max_chars.saturating_sub(16))
        .utf8_lossy()
        .into_owned();
    (format!("{}\n...[truncated]", clipped.trim_end()), true)
}

pub(super) fn now_iso() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis().min(i64::MAX as u128)).unwrap_or(i64::MAX)
        });
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(millis)
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".into())
}

fn shared_limitations(quality: &str, truncated: bool, warnings: &[String]) -> Vec<String> {
    let mut limitations = Vec::new();
    if quality == "limited" {
        limitations.push("The page reader classified this evidence as limited.".into());
    }
    if truncated {
        limitations.push("The page evidence was truncated to the configured read bound.".into());
    }
    limitations.extend(
        warnings
            .iter()
            .map(|warning| warning.trim())
            .filter(|warning| !warning.is_empty())
            .take(4)
            .map(str::to_owned),
    );
    limitations
}

fn unique_limitations(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| !value.is_empty() && seen.insert(value.clone()))
        .collect()
}

fn hex_prefix(hash: &[u8], chars: usize) -> String {
    let mut output = String::with_capacity(chars);
    for byte in hash.iter().take(chars.div_ceil(2)) {
        use std::fmt::Write as _;
        let _ = write!(&mut output, "{byte:02x}");
    }
    output.truncate(chars);
    output
}
