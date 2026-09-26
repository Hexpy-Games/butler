use std::time::Instant;

use futures_util::FutureExt;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::web_access::service::{WebAccess, WebAccessError};

use super::{
    contracts::{SearchInput, SearchOutput, SearchProvider, filter_results},
    http::response_bytes,
    responses::{overview_from_response, results_from_response},
};

pub(super) struct OpenAIWebSearchProvider {
    api_key: String,
    model: Option<String>,
    api_base: Option<String>,
}

impl OpenAIWebSearchProvider {
    pub(super) fn new(api_key: String, model: Option<String>, api_base: Option<String>) -> Self {
        Self {
            api_key,
            model,
            api_base,
        }
    }
}

impl SearchProvider for OpenAIWebSearchProvider {
    fn id(&self) -> &str {
        "openai-web-search"
    }

    fn search<'a>(
        &'a self,
        access: &'a WebAccess,
        input: &'a SearchInput,
        cancellation: &'a CancellationToken,
    ) -> futures_util::future::BoxFuture<'a, Result<SearchOutput, WebAccessError>> {
        async move {
            let started = Instant::now();
            let mut tool = json!({"type":"web_search"});
            if !input.allowed_domains.is_empty() {
                tool["filters"] = json!({"allowed_domains":input.allowed_domains});
            }
            let endpoint = join_endpoint(
                self.api_base.as_deref().unwrap_or("https://api.openai.com"),
                "/v1/responses",
            )?;
            let request = access.client().post(endpoint).bearer_auth(&self.api_key).json(&json!({
                "model":self.model.as_deref().filter(|value| !value.trim().is_empty()).unwrap_or("gpt-5"),
                "instructions":"Use web search. Return one short source-backed overview with citations and the supporting sources.",
                "tools":[tool],
                "tool_choice":"auto",
                "include":["web_search_call.action.sources"],
                "input":input.query,
            }));
            let (status, bytes) = response_bytes(access, request, cancellation).await?;
            if !(200..300).contains(&status) {
                return Err(http_error(status));
            }
            let payload: Value = serde_json::from_slice(&bytes).map_err(|_| {
                WebAccessError::new(
                    "web_search_response_invalid",
                    "OpenAI web search returned an invalid response.",
                )
            })?;
            let results = filter_results(results_from_response(&payload), input);
            let provider_overview = input
                .blocked_domains
                .is_empty()
                .then(|| overview_from_response(&payload))
                .flatten();
            Ok(SearchOutput {
                results,
                provider_overview,
                duration_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                provider: self.id().to_owned(),
                search_requests: 1,
                search_warnings: Vec::new(),
                failed_queries: Vec::new(),
            })
        }
        .boxed()
    }
}

pub(super) fn join_endpoint(base: &str, suffix: &str) -> Result<Url, WebAccessError> {
    let base = base.trim_end_matches('/');
    Url::parse(&format!("{base}{suffix}")).map_err(|_| {
        WebAccessError::new(
            "web_access_configuration_invalid",
            "Search endpoint is invalid.",
        )
    })
}

fn http_error(status: u16) -> WebAccessError {
    WebAccessError::new(
        "web_search_provider_failed",
        format!("OpenAI web search failed with HTTP {status}."),
    )
}
