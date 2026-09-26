mod brave;
mod codex;
pub(super) mod contracts;
mod duckduckgo;
mod http;
mod openai;
mod responses;
mod tavily;

use futures_util::FutureExt;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{
    models::ProviderAuth,
    web_access::service::{WebAccess, WebAccessError},
};

use self::{
    brave::BraveWebSearchProvider,
    codex::CodexSubscriptionWebSearchProvider,
    contracts::{SearchInput, SearchOutput, SearchProvider, SearchResult},
    duckduckgo::DuckDuckGoHtmlSearchProvider,
    openai::OpenAIWebSearchProvider,
    tavily::TavilyWebSearchProvider,
};

pub(super) async fn configured(
    access: &WebAccess,
) -> Result<Box<dyn SearchProvider>, WebAccessError> {
    let config = access.config().unwrap_or_else(|_| serde_json::json!({}));
    let settings = &config["webSearch"];
    let provider = access
        .configured_provider()
        .unwrap_or_else(|_| "duckduckgo-html".into());
    let model = string_value(settings.get("model"));
    let api_base = string_value(settings.get("apiBase"));
    let brave_base = string_value(settings.get("braveApiBase"));
    let tavily_base = string_value(settings.get("tavilyApiBase"));
    let ddg = || Box::new(DuckDuckGoHtmlSearchProvider::new(None)) as Box<dyn SearchProvider>;
    let provider: Box<dyn SearchProvider> = match provider.as_str() {
        "disabled" => Box::new(DisabledSearchProvider),
        "duckduckgo" | "duckduckgo-html" => ddg(),
        "mock" => Box::new(MockSearchProvider),
        "brave" => match first_env(
            access,
            &["BUTLER_BRAVE_SEARCH_API_KEY", "BRAVE_SEARCH_API_KEY"],
        )? {
            Some(key) => fallback(
                Box::new(BraveWebSearchProvider::new(key, brave_base)),
                ddg(),
            ),
            None => ddg(),
        },
        "tavily" => match first_env(access, &["BUTLER_TAVILY_API_KEY", "TAVILY_API_KEY"])? {
            Some(key) => fallback(
                Box::new(TavilyWebSearchProvider::new(key, tavily_base)),
                ddg(),
            ),
            None => ddg(),
        },
        "openai-web-search" => match access.environment_value("OPENAI_API_KEY")? {
            Some(key) => fallback(
                Box::new(OpenAIWebSearchProvider::new(key, model, api_base)),
                ddg(),
            ),
            None => ddg(),
        },
        "codex-subscription-web-search" => match resolve_auth(access).await {
            Ok(auth) => {
                match CodexSubscriptionWebSearchProvider::from_auth(auth, model, api_base) {
                    Ok(primary) => fallback(Box::new(primary), ddg()),
                    Err(_) => ddg(),
                }
            }
            Err(_) => ddg(),
        },
        "auto" => {
            if let Some(key) = first_env(
                access,
                &["BUTLER_BRAVE_SEARCH_API_KEY", "BRAVE_SEARCH_API_KEY"],
            )? {
                fallback(
                    Box::new(BraveWebSearchProvider::new(key, brave_base)),
                    ddg(),
                )
            } else if let Some(key) =
                first_env(access, &["BUTLER_TAVILY_API_KEY", "TAVILY_API_KEY"])?
            {
                fallback(
                    Box::new(TavilyWebSearchProvider::new(key, tavily_base)),
                    ddg(),
                )
            } else {
                match resolve_auth(access).await {
                    Ok(ProviderAuth::ApiKey(key)) => fallback(
                        Box::new(OpenAIWebSearchProvider::new(key, model, api_base)),
                        ddg(),
                    ),
                    Ok(auth @ ProviderAuth::Codex { .. }) => {
                        match CodexSubscriptionWebSearchProvider::from_auth(auth, model, api_base) {
                            Ok(primary) => fallback(Box::new(primary), ddg()),
                            Err(_) => ddg(),
                        }
                    }
                    _ => ddg(),
                }
            }
        }
        _ => ddg(),
    };
    Ok(provider)
}

pub(super) fn status(access: &WebAccess) -> Result<Value, WebAccessError> {
    let provider = access
        .configured_provider()
        .unwrap_or_else(|_| "duckduckgo-html".into());
    let brave_key = access
        .environment_value("BUTLER_BRAVE_SEARCH_API_KEY")?
        .or_else(|| process_env("BRAVE_SEARCH_API_KEY"))
        .is_some();
    let tavily_key = access
        .environment_value("BUTLER_TAVILY_API_KEY")?
        .or_else(|| process_env("TAVILY_API_KEY"))
        .is_some();
    let openai_key = access.environment_value("OPENAI_API_KEY")?.is_some();
    let provider_effective = match provider.as_str() {
        "disabled" => "disabled",
        "mock" => "mock",
        "duckduckgo" | "duckduckgo-html" => "duckduckgo-html",
        "brave" if brave_key => "brave-with-duckduckgo-html-fallback",
        "brave" => "duckduckgo-html",
        "tavily" if tavily_key => "tavily-with-duckduckgo-html-fallback",
        "tavily" => "duckduckgo-html",
        "openai-web-search" if openai_key => "openai-web-search-with-duckduckgo-html-fallback",
        "openai-web-search" => "duckduckgo-html",
        "codex-subscription-web-search" => {
            "codex-subscription-web-search-with-duckduckgo-html-fallback"
        }
        "auto" => "auto-web-search",
        _ => "duckduckgo-html",
    };
    let reader_backend = access
        .configured_reader(None)
        .unwrap_or_else(|_| "lightweight".into());
    Ok(json!({
        "provider": provider,
        "providerEffective": provider_effective,
        "braveKeyConfigured": brave_key,
        "tavilyKeyConfigured": tavily_key,
        "openAIKeyConfigured": openai_key,
        "readerBackend": reader_backend,
        "metrics": access.metrics().summary(),
        "redacted": true,
    }))
}

pub(super) async fn test_search(
    access: &WebAccess,
    query: &str,
    cancellation: &CancellationToken,
) -> Result<Value, WebAccessError> {
    if cancellation.is_cancelled() {
        return Err(WebAccessError::cancelled());
    }
    let provider = configured(access).await?;
    let output = provider
        .search(
            access,
            &SearchInput {
                query: query.trim().to_owned(),
                allowed_domains: Vec::new(),
                blocked_domains: Vec::new(),
                max_results: 5,
                requested_max_results: None,
                recency_days: None,
            },
            cancellation,
        )
        .await?;
    let results = output
        .results
        .iter()
        .map(|result| {
            json!({
                "title": result.title,
                "source": result.source,
                "url": result.url,
                "snippet": utf16_prefix(&result.snippet, 300),
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "provider": output.provider,
        "duration_ms": output.duration_ms,
        "results": results,
        "usage": { "search_requests": output.search_requests },
    }))
}

fn utf16_prefix(value: &str, max: usize) -> String {
    crate::json::Utf16Slice::new(value, 0, max)
        .utf8_lossy()
        .into_owned()
}

fn process_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

async fn resolve_auth(access: &WebAccess) -> Result<ProviderAuth, WebAccessError> {
    let configuration = access.configuration().ok_or_else(|| {
        WebAccessError::new(
            "web_search_provider_auth_missing",
            "Web search provider authentication is unavailable.",
        )
    })?;
    let private_environment = access.private_environment()?;
    configuration
        .resolve_openai_auth_for_web_search(&private_environment)
        .await
        .map_err(|_| {
            WebAccessError::new(
                "web_search_provider_auth_missing",
                "Web search provider authentication is unavailable.",
            )
        })
}

fn first_env(access: &WebAccess, names: &[&str]) -> Result<Option<String>, WebAccessError> {
    for name in names {
        if let Some(value) = access.environment_value(name)? {
            return Ok(Some(value));
        }
    }
    Ok(None)
}

fn string_value(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn fallback(
    primary: Box<dyn SearchProvider>,
    secondary: Box<dyn SearchProvider>,
) -> Box<dyn SearchProvider> {
    let id = format!("{}-with-{}-fallback", primary.id(), secondary.id());
    let concurrency = primary
        .planned_concurrency()
        .unwrap_or(usize::MAX)
        .min(secondary.planned_concurrency().unwrap_or(usize::MAX));
    Box::new(FallbackSearchProvider {
        primary,
        secondary,
        id,
        concurrency: (concurrency != usize::MAX).then_some(concurrency),
    })
}

struct FallbackSearchProvider {
    primary: Box<dyn SearchProvider>,
    secondary: Box<dyn SearchProvider>,
    id: String,
    concurrency: Option<usize>,
}

impl SearchProvider for FallbackSearchProvider {
    fn id(&self) -> &str {
        &self.id
    }

    fn planned_concurrency(&self) -> Option<usize> {
        self.concurrency
    }

    fn search<'a>(
        &'a self,
        access: &'a WebAccess,
        input: &'a SearchInput,
        cancellation: &'a CancellationToken,
    ) -> futures_util::future::BoxFuture<'a, Result<SearchOutput, WebAccessError>> {
        async move {
            match self.primary.search(access, input, cancellation).await {
                Ok(output) => Ok(output),
                Err(error)
                    if error.code == "invalid_arguments"
                        || error.code == "web_search_input_validation"
                        || cancellation.is_cancelled() =>
                {
                    Err(if cancellation.is_cancelled() {
                        WebAccessError::cancelled()
                    } else {
                        error
                    })
                }
                Err(_) => self.secondary.search(access, input, cancellation).await,
            }
        }
        .boxed()
    }
}

struct MockSearchProvider;

impl SearchProvider for MockSearchProvider {
    fn id(&self) -> &'static str {
        "mock"
    }

    fn search<'a>(
        &'a self,
        _access: &'a WebAccess,
        input: &'a SearchInput,
        cancellation: &'a CancellationToken,
    ) -> futures_util::future::BoxFuture<'a, Result<SearchOutput, WebAccessError>> {
        async move {
            if cancellation.is_cancelled() {
                return Err(WebAccessError::cancelled());
            }
            let result = SearchResult {
                title: "Butler Web Search Fixture".into(),
                url: "https://example.com/butler-web-search".into(),
                snippet: "A deterministic search fixture for Butler tests.".into(),
                source: "example.com".into(),
                published_at: Some("2026-04-26".into()),
            };
            let results = contracts::filter_results(vec![result], input);
            Ok(SearchOutput::direct(self.id(), results, 0))
        }
        .boxed()
    }
}

struct DisabledSearchProvider;

impl SearchProvider for DisabledSearchProvider {
    fn id(&self) -> &'static str {
        "disabled"
    }

    fn search<'a>(
        &'a self,
        _access: &'a WebAccess,
        _input: &'a SearchInput,
        _cancellation: &'a CancellationToken,
    ) -> futures_util::future::BoxFuture<'a, Result<SearchOutput, WebAccessError>> {
        async {
            Err(WebAccessError::new(
                "web_search_provider_disabled",
                "Web search is disabled by configuration.",
            ))
        }
        .boxed()
    }
}
