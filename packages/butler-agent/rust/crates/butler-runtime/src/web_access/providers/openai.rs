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
use crate::web_access::WebAccessCode;

pub(super) struct OpenAIWebSearchProvider {
    api_key: String,
    model: Option<String>,
    api_base: Option<String>,
}

impl OpenAIWebSearchProvider {
    pub(super) fn new(api_key: &str, model: Option<String>, api_base: Option<String>) -> Self {
        Self {
            api_key: api_key.to_owned(),
            model,
            api_base,
        }
    }
}

impl SearchProvider for OpenAIWebSearchProvider {
    fn id(&self) -> &'static str {
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
            let catalog = butler_models::models::ModelCatalog::new().map_err(|error|
                WebAccessError::new(WebAccessCode::WebSearchProviderModelMissing, error.to_string()))?;
            let default_model = butler_models::models::parse_model_ref(
                &catalog.default_preset(&Value::Null, &Value::Null).model).model_id;
            let mut tool = json!({"type":"web_search"});
            if !input.allowed_domains.is_empty() {
                tool["filters"] = json!({"allowed_domains":input.allowed_domains});
            }
            let endpoint = join_endpoint(
                self.api_base.as_deref().unwrap_or("https://api.openai.com"),
                "/v1/responses",
            )?;
            let request = access.client().post(endpoint).bearer_auth(&self.api_key).json(&json!({
                "model":self.model.as_deref().filter(|value| !value.trim().is_empty()).unwrap_or(&default_model),
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
            let payload: Value = serde_json::from_slice(&bytes).map_err(|source| WebAccessError::new(
                    WebAccessCode::WebSearchResponseInvalid,
                    "OpenAI web search returned an invalid response.",
                ).with_source(source))?;
            let results = filter_results(results_from_response(&payload), input);
            let provider_overview = input
                .blocked_domains
                .is_empty()
                .then(|| overview_from_response(&payload))
                .flatten();
            Ok(SearchOutput {
                results,
                provider_overview,
                duration_ms: u64::try_from(started.elapsed().as_millis().min(u128::from(u64::MAX))).unwrap_or(u64::MAX),
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
    Url::parse(&format!("{base}{suffix}")).map_err(|source| {
        WebAccessError::new(
            WebAccessCode::WebAccessConfigurationInvalid,
            "Search endpoint is invalid.",
        )
        .with_source(source)
    })
}

fn http_error(status: u16) -> WebAccessError {
    WebAccessError::new(
        WebAccessCode::WebSearchProviderFailed,
        format!("OpenAI web search failed with HTTP {status}."),
    )
}
