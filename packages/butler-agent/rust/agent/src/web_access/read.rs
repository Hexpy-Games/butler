use super::{
    evidence,
    page::PageRead,
    service::{WebAccessError, WebSession},
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use url::Url;

mod fetch;
pub(super) mod lightpanda;

impl super::service::WebAccess {
    pub(crate) async fn read_cli(
        &self,
        requested_url: &str,
        cancellation: &CancellationToken,
    ) -> Result<Value, WebAccessError> {
        let backend = self.configured_reader(None)?;
        if backend == "disabled" {
            let page = PageRead::unavailable(
                requested_url,
                requested_url,
                "disabled",
                "page reader backend is disabled",
                "page-reader-disabled",
            );
            return Ok(cli_projection(&page));
        }
        let Ok(parsed) = Url::parse(requested_url) else {
            return Ok(cli_invalid_url(requested_url));
        };
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Ok(cli_invalid_url(requested_url));
        }
        let page = self
            .read_page(parsed, requested_url, &backend, cancellation)
            .await?;
        Ok(cli_projection(&page))
    }
}

fn cli_projection(page: &PageRead) -> Value {
    let compact = page
        .markdown
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let preview = crate::json::Utf16Slice::new(&compact, 0, 500)
        .utf8_lossy()
        .into_owned();
    json!({
        "ok": page.ok,
        "reader": page.reader,
        "requestedUrl": page.requested_url,
        "finalUrl": page.final_url,
        "status": page.status,
        "title": page.title,
        "method": page.method,
        "durationMs": page.duration_ms,
        "warnings": page.warnings,
        "renderRecommended": page.render_recommended,
        "preview": preview,
        "chunkCount": page.chunks.len(),
        "error": page.error,
    })
}

fn cli_invalid_url(requested_url: &str) -> Value {
    let mut page = PageRead::unavailable(
        requested_url,
        requested_url,
        "butler-lightweight",
        "Page URL could not be read.",
        "page-read-failed",
    );
    page.warnings.clear();
    page.render_recommended = true;
    cli_projection(&page)
}

const DEFAULT_MAX_CHARS: usize = 2_000;
const DEFAULT_MAX_CHUNKS: usize = 1;
const CHUNK_TEXT_CHARS: usize = 320;
impl WebSession {
    pub(crate) async fn web_read(
        &self,
        args: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, WebAccessError> {
        let requested_url = args
            .get("url")
            .and_then(Value::as_str)
            .map(crate::public_text::trim_js_whitespace)
            .unwrap_or_default();
        let parsed = Url::parse(requested_url).map_err(|_| {
            WebAccessError::new("invalid_arguments", "web_read requires a valid URL.")
        })?;
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err(WebAccessError::new(
                "invalid_arguments",
                "web_read only supports public http(s) URLs without embedded credentials.",
            ));
        }
        let max_chars = bounded_number(args.get("max_chars"), 1_500, 8_000, DEFAULT_MAX_CHARS);
        let max_chunks = bounded_number(args.get("max_chunks"), 1, 8, DEFAULT_MAX_CHUNKS);
        let start_chunk = bounded_number(args.get("start_chunk"), 0, 9_007_199_254_740_991, 0);
        let explicit_backend = args
            .get("backend")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| {
                matches!(
                    *value,
                    "auto" | "lightpanda" | "lightweight" | "jina-hosted" | "disabled"
                )
            });
        let backend = self.access.configured_reader(explicit_backend)?;
        let cache_key = format!("{backend}:{}", parsed.as_str());
        let observation_key = format!("{cache_key}:{start_chunk}:{max_chars}:{max_chunks}");
        if let Some(mut cached) = self.cached_observation(&observation_key) {
            cached["cache_hit"] = Value::Bool(true);
            cached["duplicate_observation"] = Value::Bool(true);
            return Ok(cached);
        }
        let cached_page = self.cached_page(&cache_key).await?;
        let (page, cache_hit) = match cached_page {
            Some(page) => (page, true),
            None => {
                let page = self
                    .access
                    .read_page(parsed.clone(), requested_url, &backend, cancellation)
                    .await?;
                self.remember_page(cache_key.clone(), &page).await?;
                (page, false)
            }
        };
        let observation = bounded_result(&page, max_chars, max_chunks, start_chunk);
        let source_url = observation["source_url"]
            .as_str()
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| parsed.as_str().to_owned());
        let warnings = page.warnings.clone();
        let quality = observation["evidence_quality"]
            .as_str()
            .unwrap_or("unavailable")
            .to_owned();
        let markdown = observation["markdown"].as_str().unwrap_or("").to_owned();
        let chunk_values = observation["chunks"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let truncated = observation["truncated"] == Value::Bool(true);
        let ok = observation["ok"] == Value::Bool(true)
            && quality != "unavailable"
            && (!markdown.trim().is_empty() || !chunk_values.is_empty());
        let observed_at = evidence::now_iso();
        let mut result = observation;
        result["public_web_evidence_items"] = Value::Array(evidence::read_items(
            &source_url,
            &markdown,
            &chunk_values,
            &observed_at,
            &quality,
            truncated,
            &warnings,
        ));
        result["evidence_capability_receipts"] =
            Value::Array(vec![evidence::read_capability_receipt(
                ok,
                &source_url,
                &quality,
                truncated,
                result["error"].as_str(),
                &observed_at,
            )]);
        result["evidence_receipts"] = Value::Array(vec![evidence::tool_receipt(
            &evidence::ToolReceiptInput {
                tool: "web_read",
                receipt_type: "source",
                summary: if ok {
                    "A public source page was read and bounded page evidence was returned."
                } else {
                    "A public source read did not produce readable evidence; its limitation was returned."
                },
                verified: ok,
                covers: &["source_verified"],
                satisfies: if ok { &["source_verified"] } else { &[] },
                urls: &[source_url],
                metrics: json!({
                    "returned_chunks":result["returned_chunks"].as_u64().unwrap_or(0),
                    "total_chunks":result["total_chunks"].as_u64().unwrap_or(0),
                }),
            },
        )]);
        result["cache_hit"] = Value::Bool(cache_hit);
        result["duplicate_observation"] = Value::Bool(false);
        self.remember_observation(observation_key, result.clone());
        Ok(result)
    }
}

fn bounded_result(page: &PageRead, max_chars: usize, max_chunks: usize, start: usize) -> Value {
    let candidates = page
        .chunks
        .iter()
        .skip(start)
        .take(max_chunks)
        .collect::<Vec<_>>();
    let mut selected = Vec::new();
    let mut window = String::new();
    for chunk in &candidates {
        let next = if window.is_empty() {
            chunk.text.clone()
        } else {
            format!("{window}\n\n{}", chunk.text)
        };
        if next.encode_utf16().count() > max_chars {
            break;
        }
        selected.push(*chunk);
        window = next;
    }
    let (markdown, markdown_truncated) = if page.chunks.is_empty() {
        bounded_text(if start == 0 { &page.markdown } else { "" }, max_chars)
    } else if !selected.is_empty() {
        (window, false)
    } else if let Some(first) = candidates.first() {
        bounded_text(&first.text, max_chars)
    } else {
        (String::new(), false)
    };
    let next_start = (start + selected.len() < page.chunks.len()).then_some(start + selected.len());
    let has_more = next_start.is_some();
    let has_evidence = !markdown.trim().is_empty() || !selected.is_empty();
    let evidence_quality = if !has_evidence {
        "unavailable"
    } else if page.ok && page.text.encode_utf16().count() >= 500 && page.warnings.is_empty() {
        "good"
    } else if page.ok && !page.text.is_empty() {
        "limited"
    } else {
        "unavailable"
    };
    let chunks = selected
        .iter()
        .map(|chunk| {
            let (text, _) = bounded_text(&chunk.text, max_chars.min(CHUNK_TEXT_CHARS));
            json!({
                "id":chunk.id,
                "index":chunk.index,
                "title":chunk.title,
                "url":chunk.url,
                "text":text,
                "char_count":chunk.char_count,
            })
        })
        .collect::<Vec<_>>();
    json!({
        "ok":page.ok,
        "reader":page.reader,
        "requested_url":page.requested_url,
        "final_url":page.final_url,
        "source_url":page.final_url,
        "status":page.status,
        "title":page.title,
        "method":page.method,
        "warnings":page.warnings,
        "render_recommended":page.render_recommended,
        "duration_ms":page.duration_ms,
        "markdown":markdown,
        "start_chunk":start,
        "returned_chunks":selected.len(),
        "total_chunks":page.chunks.len(),
        "next_start_chunk":next_start,
        "effective_max_chars":max_chars,
        "effective_max_chunks":max_chunks,
        "content_has_more":has_more,
        "markdown_truncated":markdown_truncated,
        "truncated":markdown_truncated || has_more,
        "chunks":chunks,
        "evidence_quality":evidence_quality,
        "error":page.error,
    })
}

fn bounded_number(value: Option<&Value>, min: usize, max: usize, fallback: usize) -> usize {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(|value| crate::json::saturating_usize(value.trunc().clamp(min as f64, max as f64)))
        .unwrap_or(fallback)
}

fn bounded_text(value: &str, max: usize) -> (String, bool) {
    let units = value.encode_utf16().count();
    if units <= max {
        return (value.to_owned(), false);
    }
    let text = crate::json::Utf16Slice::new(value, 0, max.saturating_sub(16))
        .utf8_lossy()
        .into_owned();
    (format!("{}\n...[truncated]", text.trim_end()), true)
}
