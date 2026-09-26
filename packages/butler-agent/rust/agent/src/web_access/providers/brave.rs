use std::time::Instant;

use futures_util::FutureExt;
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::web_access::service::{WebAccess, WebAccessError};

use super::{
    contracts::{SearchInput, SearchOutput, SearchProvider, SearchResult, filter_results},
    http::response_bytes,
};

pub(super) struct BraveWebSearchProvider {
    api_key: String,
    api_base: Option<String>,
}

impl BraveWebSearchProvider {
    pub(super) fn new(api_key: String, api_base: Option<String>) -> Self {
        Self { api_key, api_base }
    }
}

impl SearchProvider for BraveWebSearchProvider {
    fn id(&self) -> &'static str {
        "brave"
    }

    fn search<'a>(
        &'a self,
        access: &'a WebAccess,
        input: &'a SearchInput,
        cancellation: &'a CancellationToken,
    ) -> futures_util::future::BoxFuture<'a, Result<SearchOutput, WebAccessError>> {
        async move {
            let started = Instant::now();
            let mut url = Url::parse(
                self.api_base
                    .as_deref()
                    .unwrap_or("https://api.search.brave.com/res/v1/web/search"),
            )
            .map_err(|_| invalid_endpoint())?;
            {
                let mut query = url.query_pairs_mut();
                query.append_pair("q", &input.query);
                query.append_pair("count", &input.max_results.to_string());
                if let Some(days) = input.recency_days {
                    query.append_pair(
                        "freshness",
                        if days <= 1 {
                            "pd"
                        } else if days <= 7 {
                            "pw"
                        } else {
                            "pm"
                        },
                    );
                }
            }
            let request = access
                .client()
                .get(url)
                .header(reqwest::header::ACCEPT, "application/json")
                .header("X-Subscription-Token", &self.api_key);
            let (status, bytes) = response_bytes(access, request, cancellation).await?;
            if !(200..300).contains(&status) {
                return Err(http_error("Brave", status));
            }
            let payload: Value = serde_json::from_slice(&bytes).map_err(|_| {
                WebAccessError::new(
                    "web_search_response_invalid",
                    "Brave returned an invalid response.",
                )
            })?;
            let results = payload
                .pointer("/web/results")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(parse_result)
                .collect();
            Ok(SearchOutput::direct(
                self.id(),
                filter_results(results, input),
                elapsed_ms(started),
            ))
        }
        .boxed()
    }
}

fn parse_result(value: &Value) -> Option<SearchResult> {
    let url = value.get("url")?.as_str()?.trim();
    if url.is_empty() || !valid_public_url(url) {
        return None;
    }
    Some(SearchResult {
        title: string_field(value, "title").unwrap_or_else(|| url.to_owned()),
        url: url.to_owned(),
        snippet: string_field(value, "description").unwrap_or_default(),
        source: super::contracts::compact_domain(url),
        published_at: string_field(value, "age"),
    })
}

fn string_field(value: &Value, name: &str) -> Option<String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn valid_public_url(value: &str) -> bool {
    Url::parse(value).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.username().is_empty()
            && url.password().is_none()
    })
}

fn invalid_endpoint() -> WebAccessError {
    WebAccessError::new(
        "web_access_configuration_invalid",
        "Search endpoint is invalid.",
    )
}

fn http_error(provider: &str, status: u16) -> WebAccessError {
    WebAccessError::new(
        "web_search_provider_failed",
        format!("{provider} web search failed with HTTP {status}."),
    )
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis().min(u128::from(u64::MAX))).unwrap_or(u64::MAX)
}
