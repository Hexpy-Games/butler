//! `web_read {tab}`: the tab's document, read live on every call.
use super::{live_page, observed, read_result};
use crate::web_access::{
    page::PageRead,
    service::{LivePage, WebAccessError, WebSession},
};
use serde_json::{Value, json};
use url::Url;

impl WebSession {
    /// A tab is read live every time: a click can change its page without a
    /// navigation. Only content identical to this window's previous read
    /// (same hash) is answered by reference; any change returns fresh text.
    pub(super) async fn read_tab(
        &self,
        live: LivePage,
        (parsed, requested_url): (&Url, &str),
        (max_chars, max_chunks, start_chunk): (usize, usize, usize),
        observation_key: String,
        query: Option<&str>,
    ) -> Result<Value, WebAccessError> {
        let page = live_page(live, requested_url).await?;
        let digest = content_digest(&page);
        if query.is_none()
            && let Some(previous) = self.cached_observation(&observation_key)
            && previous["content_sha256"] == digest.as_str()
        {
            return Ok(unchanged(&previous, &digest));
        }
        let observation = read_result(&page, max_chars, max_chunks, start_chunk, query);
        let mut result = observed(&page, parsed, observation);
        result["cache_hit"] = Value::Bool(false);
        result["duplicate_observation"] = Value::Bool(false);
        result["content_sha256"] = Value::String(digest.clone());
        result["read_id"] = Value::String(read_id(&digest, start_chunk));
        self.remember_observation(observation_key, result.clone());
        Ok(result)
    }
}

/// SHA-256 over the extracted page text and its chunks.
fn content_digest(page: &PageRead) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update(page.final_url.as_bytes());
    hash.update([0]);
    hash.update(page.markdown.as_bytes());
    for chunk in &page.chunks {
        hash.update([0]);
        hash.update(chunk.text.as_bytes());
    }
    format!("{:x}", hash.finalize())
}

fn read_id(digest: &str, start_chunk: usize) -> String {
    format!("{}:{start_chunk}", &digest[..12.min(digest.len())])
}

/// The answer to a re-read of an identical page window: the earlier result
/// still applies, so its text is not sent again.
fn unchanged(previous: &Value, digest: &str) -> Value {
    let same_as = previous["read_id"].clone();
    json!({
        "ok": previous["ok"],
        "unchanged": true,
        "same_as": same_as,
        "content_sha256": digest,
        "source_url": previous["source_url"],
        "final_url": previous["final_url"],
        "title": previous["title"],
        "start_chunk": previous["start_chunk"],
        "returned_chunks": previous["returned_chunks"],
        "total_chunks": previous["total_chunks"],
        "next_start_chunk": previous["next_start_chunk"],
        "content_has_more": previous["content_has_more"],
        "note": format!("The page shows exactly the content of read {} earlier in this turn (identical content hash), so that result still applies. Read another start_chunk for more of the page.", same_as.as_str().unwrap_or("")),
    })
}
