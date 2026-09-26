use std::time::Instant;

use futures_util::FutureExt;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::web_access::service::{WebAccess, WebAccessError};

use super::contracts::{SearchInput, SearchOutput, SearchProvider, SearchResult};
use super::http::response_bytes;

pub(super) struct TavilyWebSearchProvider {
    api_key: String,
    api_base: Option<String>,
}

impl TavilyWebSearchProvider {
    pub(super) fn new(api_key: String, api_base: Option<String>) -> Self {
        Self { api_key, api_base }
    }
}

impl SearchProvider for TavilyWebSearchProvider {
    fn id(&self) -> &'static str {
        "tavily"
    }

    fn search<'a>(
        &'a self,
        access: &'a WebAccess,
        input: &'a SearchInput,
        cancellation: &'a CancellationToken,
    ) -> futures_util::future::BoxFuture<'a, Result<SearchOutput, WebAccessError>> {
        async move {
            let started = Instant::now();
            let endpoint = Url::parse(
                self.api_base
                    .as_deref()
                    .unwrap_or("https://api.tavily.com/search"),
            )
            .map_err(|_| invalid_endpoint())?;
            let mut body = json!({
                "query":input.query,
                "search_depth":"basic",
                "max_results":input.max_results,
                "include_domains":input.allowed_domains,
                "exclude_domains":input.blocked_domains,
            });
            if let Some(days) = input.recency_days {
                body["days"] = json!(days);
            }
            let request = access
                .client()
                .post(endpoint)
                .bearer_auth(&self.api_key)
                .json(&body);
            let (status, bytes) = response_bytes(access, request, cancellation).await?;
            if !(200..300).contains(&status) {
                return Err(WebAccessError::new(
                    "web_search_provider_failed",
                    format!("Tavily web search failed with HTTP {status}."),
                ));
            }
            let payload: Value = serde_json::from_slice(&bytes).map_err(|_| {
                WebAccessError::new(
                    "web_search_response_invalid",
                    "Tavily returned an invalid response.",
                )
            })?;
            let results = payload
                .get("results")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(parse_result)
                .filter(|result| {
                    super::contracts::matches_domains(&result.url, &input.allowed_domains)
                })
                .filter(|result| {
                    !super::contracts::matches_domains(&result.url, &input.blocked_domains)
                })
                .take(input.max_results)
                .collect::<Vec<_>>();
            Ok(SearchOutput::direct(
                self.id(),
                results,
                started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
            ))
        }
        .boxed()
    }
}

fn parse_result(value: &Value) -> Option<SearchResult> {
    let url = value.get("url")?.as_str()?.trim();
    if url.is_empty()
        || !Url::parse(url).is_ok_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.username().is_empty()
                && url.password().is_none()
        })
    {
        return None;
    }
    Some(SearchResult {
        title: text(value.get("title")).unwrap_or_else(|| url.to_owned()),
        url: url.to_owned(),
        snippet: text(value.get("content")).unwrap_or_default(),
        source: super::contracts::compact_domain(url),
        published_at: text(value.get("published_date")),
    })
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn invalid_endpoint() -> WebAccessError {
    WebAccessError::new(
        "web_access_configuration_invalid",
        "Search endpoint is invalid.",
    )
}
