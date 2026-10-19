mod memo;
mod request;
use request::request;
use std::time::Instant;

use futures_util::FutureExt;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::web_access::service::{WebAccess, WebAccessError};
use butler_models::models::ProviderAuth;

use super::{
    contracts::{SearchInput, SearchOutput, SearchProvider, SearchResult, filter_results},
    openai::join_endpoint,
    responses::{bounded_overview, results_from_response},
};
use crate::web_access::WebAccessCode;

pub(super) struct ChatGptPlanWebSearchProvider {
    authorization: zeroize::Zeroizing<String>,
    registration: String,
    model: Option<String>,
}

impl ChatGptPlanWebSearchProvider {
    pub(super) fn from_auth(
        auth: ProviderAuth,
        model: Option<String>,
    ) -> Result<Self, WebAccessError> {
        let ProviderAuth::ChatGptPlan {
            authorization,
            registration,
        } = auth
        else {
            return Err(auth_missing());
        };
        Ok(Self {
            authorization,
            registration,
            model,
        })
    }
}

impl SearchProvider for ChatGptPlanWebSearchProvider {
    fn id(&self) -> &'static str {
        "chatgpt-plan-web-search"
    }

    fn search<'a>(
        &'a self,
        access: &'a WebAccess,
        input: &'a SearchInput,
        cancellation: &'a CancellationToken,
    ) -> futures_util::future::BoxFuture<'a, Result<SearchOutput, WebAccessError>> {
        async move {
            let started = Instant::now();
            let configuration = access.configuration().ok_or_else(auth_missing)?;
            let model = configuration.chatgpt_search_model(self.model.as_deref()).await.map_err(|_| auth_missing())?;
            let key = (self.registration.clone(), model.clone());
            memo::admit(access.data_root(), &key)?;

            let base = configuration.chatgpt_api_base();
            let endpoint = join_endpoint(base, "/responses")?;
            let mut tool = json!({"type":"web_search"});
            if !input.allowed_domains.is_empty() {
                tool["filters"] = json!({"allowed_domains":input.allowed_domains});
            }
            let mut body = json!({
                "model":model,
                "instructions":"Use web search. Return one short source-backed overview with citations and the supporting sources.",
                "input":[{"role":"user","content":[{"type":"input_text","text":input.query}]}],
                "tools":[tool],
                "tool_choice":"auto",
                "include":["web_search_call.action.sources"],
                "stream":true,
                "store":false,
            });
            if let Some(object) = body.as_object_mut() {
                butler_models::models::chatgpt::finalize_search(object, &self.registration, &model);
            }
            let bytes = request(access, endpoint, &body, &self.authorization, &key, cancellation).await?;
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
            let duration_ms = u64::try_from(started.elapsed().as_millis().min(u128::from(u64::MAX))).unwrap_or(u64::MAX);
            let mut output = SearchOutput::direct(self.id(), results, duration_ms);
            output.provider_overview = input
                    .blocked_domains
                    .is_empty()
                    .then(|| bounded_overview(&answer))
                    .flatten();
            Ok(output)
        }
        .boxed()
    }
}

fn parse_sse(raw: &str) -> Result<(Value, String), WebAccessError> {
    let mut completed = false;
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
            "error" | "response.failed" | "response.incomplete" => {
                return Err(WebAccessError::new(
                    WebAccessCode::WebSearchProviderFailed,
                    "ChatGPT plan web search provider reported a failed response.",
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
                completed = true;
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
    if !completed {
        return Err(memo::failed());
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
        WebAccessCode::WebSearchProviderAuthMissing,
        "ChatGPT plan login is required for web search.",
    )
}
