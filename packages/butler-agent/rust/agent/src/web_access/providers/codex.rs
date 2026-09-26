use std::time::Instant;

use futures_util::FutureExt;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::{
    models::{ProviderAuth, ProviderAuthMode},
    web_access::service::{WebAccess, WebAccessError},
};

use super::{
    contracts::{SearchInput, SearchOutput, SearchProvider, SearchResult, filter_results},
    http::response_bytes,
    openai::join_endpoint,
    responses::{bounded_overview, results_from_response},
};

pub(super) struct CodexSubscriptionWebSearchProvider {
    authorization: String,
    account_id: String,
    originator: String,
    user_agent: String,
    model: Option<String>,
    api_base: Option<String>,
}

impl CodexSubscriptionWebSearchProvider {
    pub(super) fn from_auth(
        auth: ProviderAuth,
        model: Option<String>,
        api_base: Option<String>,
    ) -> Result<Self, WebAccessError> {
        let ProviderAuth::Codex {
            mode,
            authorization,
            account_id,
            user_agent,
            originator,
        } = auth
        else {
            return Err(auth_missing());
        };
        if !matches!(
            mode,
            ProviderAuthMode::CodexOauth | ProviderAuthMode::CodexSubscription
        ) {
            return Err(auth_missing());
        }
        if account_id.trim().is_empty() {
            return Err(WebAccessError::new(
                "web_search_provider_auth_missing",
                "Codex web search requires a ChatGPT account id.",
            ));
        }
        Ok(Self {
            authorization,
            account_id,
            originator,
            user_agent,
            model,
            api_base,
        })
    }
}

impl SearchProvider for CodexSubscriptionWebSearchProvider {
    fn id(&self) -> &str {
        "codex-subscription-web-search"
    }

    fn search<'a>(
        &'a self,
        access: &'a WebAccess,
        input: &'a SearchInput,
        cancellation: &'a CancellationToken,
    ) -> futures_util::future::BoxFuture<'a, Result<SearchOutput, WebAccessError>> {
        async move {
            let started = Instant::now();
            let model = codex_model(self.model.as_deref())?;
            let environment_base = access.environment_value("BUTLER_CODEX_BASE_URL")?;
            let base = self
                .api_base
                .as_deref()
                .or(environment_base.as_deref())
                .unwrap_or("https://chatgpt.com/backend-api");
            let endpoint = codex_endpoint(base)?;
            let mut tool = json!({"type":"web_search"});
            if !input.allowed_domains.is_empty() {
                tool["filters"] = json!({"allowed_domains":input.allowed_domains});
            }
            let body = json!({
                "model":model,
                "instructions":"Use web search. Return one short source-backed overview with citations and the supporting sources.",
                "input":[{"role":"user","content":[{"type":"input_text","text":input.query}]}],
                "tools":[tool],
                "tool_choice":"auto",
                "include":["web_search_call.action.sources"],
                "stream":true,
                "store":false,
            });
            let request = access
                .client()
                .post(endpoint)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .header(reqwest::header::AUTHORIZATION, &self.authorization)
                .header("chatgpt-account-id", &self.account_id)
                .header("openai-beta", "responses=experimental")
                .header("originator", &self.originator)
                .header(reqwest::header::USER_AGENT, &self.user_agent)
                .json(&body);
            let (status, bytes) = response_bytes(access, request, cancellation).await?;
            if !(200..300).contains(&status) {
                return Err(WebAccessError::new(
                    "web_search_provider_failed",
                    format!("Codex web search failed with HTTP {status}."),
                ));
            }
            let raw = String::from_utf8_lossy(&bytes);
            let (payload, answer) = parse_sse(&raw)?;
            let structured = results_from_response(&payload);
            let candidates = if structured.is_empty() {
                extract_urls(&answer)
                    .into_iter()
                    .map(|url| SearchResult {
                        title: super::contracts::compact_domain(&url),
                        source: super::contracts::compact_domain(&url),
                        url,
                        snippet: String::new(),
                        published_at: None,
                    })
                    .collect()
            } else {
                structured
            };
            let results = filter_results(candidates, input);
            Ok(SearchOutput {
                results,
                provider_overview: input
                    .blocked_domains
                    .is_empty()
                    .then(|| bounded_overview(&answer))
                    .flatten(),
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

fn codex_model(model: Option<&str>) -> Result<String, WebAccessError> {
    let model = model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            WebAccessError::new(
                "web_search_provider_model_missing",
                "Codex subscription model is required; no model fallback is allowed.",
            )
        })?;
    if model.to_ascii_lowercase().ends_with("-codex")
        && model.strip_prefix("gpt-").is_some_and(|value| {
            value
                .split('-')
                .next()
                .is_some_and(|v| v.chars().all(|c| c.is_ascii_digit() || c == '.'))
        })
    {
        Ok(model[..model.len() - "-codex".len()].to_owned())
    } else {
        Ok(model.to_owned())
    }
}

fn codex_endpoint(base: &str) -> Result<Url, WebAccessError> {
    let base = base.trim_end_matches('/');
    let path = if base.ends_with("/codex/responses") {
        ""
    } else if base.ends_with("/codex") {
        "/responses"
    } else {
        "/codex/responses"
    };
    join_endpoint(base, path)
}

fn parse_sse(raw: &str) -> Result<(Value, String), WebAccessError> {
    let mut output = Vec::new();
    let mut completed_output = Vec::new();
    let mut annotations = Vec::new();
    let (mut stream_text, mut done_text, mut item_text, mut complete_text) =
        (String::new(), String::new(), String::new(), String::new());
    for frame in raw.split("\n\n") {
        let data = frame
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim_start)
            .collect::<Vec<_>>()
            .join("\n");
        if data.trim().is_empty() || data.trim() == "[DONE]" {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        match event.get("type").and_then(Value::as_str).unwrap_or("") {
            "error" | "response.failed" => {
                return Err(WebAccessError::new(
                    "web_search_provider_failed",
                    "Codex web search provider reported a failed response.",
                ));
            }
            "response.output_text.delta" => {
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    stream_text.push_str(delta);
                }
            }
            "response.output_text.done" => {
                if let Some(text) = event.get("text").and_then(Value::as_str) {
                    done_text = text.to_owned();
                }
            }
            "response.output_text.annotation.added" => {
                if let Some(annotation) = event.get("annotation") {
                    annotations.push(annotation.clone());
                }
            }
            "response.output_item.done" => {
                if let Some(item) = event.get("item") {
                    output.push(item.clone());
                    item_text.push_str(&content_text(item));
                }
            }
            "response.completed" => {
                if let Some(response) = event.get("response") {
                    if let Some(items) = response.get("output").and_then(Value::as_array) {
                        completed_output = items.clone();
                    }
                    if let Some(text) = response.get("output_text").and_then(Value::as_str) {
                        complete_text = text.to_owned();
                    }
                }
            }
            _ => {}
        }
    }
    output.extend(completed_output);
    if !annotations.is_empty() {
        output.push(json!({"type":"message","content":[{"annotations":annotations}]}));
    }
    let answer = [stream_text, done_text, item_text, complete_text]
        .into_iter()
        .find(|text| !text.is_empty())
        .unwrap_or_default()
        .trim()
        .to_owned();
    Ok((json!({"output":output}), answer))
}

fn content_text(item: &Value) -> String {
    item.get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect()
}

fn extract_urls(text: &str) -> Vec<String> {
    let mut urls = Vec::new();
    for token in text.split_whitespace() {
        let start = token.find("http://").or_else(|| token.find("https://"));
        let Some(start) = start else { continue };
        let value = token[start..].trim_end_matches(['.', ',', ';', ':', ')', ']', '}']);
        if Url::parse(value).is_ok_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.username().is_empty()
                && url.password().is_none()
        }) && !urls.iter().any(|current| current == value)
        {
            urls.push(value.to_owned());
        }
    }
    urls
}

fn auth_missing() -> WebAccessError {
    WebAccessError::new(
        "web_search_provider_auth_missing",
        "Codex subscription login is required for web search.",
    )
}
