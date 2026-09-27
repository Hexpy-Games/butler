use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::web_access::service::WebAccessError;

#[derive(Clone, Debug)]
pub(in crate::web_access) struct SearchInput {
    pub query: String,
    pub allowed_domains: Vec<String>,
    pub blocked_domains: Vec<String>,
    pub max_results: usize,
    pub requested_max_results: Option<usize>,
    pub recency_days: Option<u64>,
}

#[derive(Clone, Debug)]
pub(in crate::web_access) struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub source: String,
    pub published_at: Option<String>,
}

#[derive(Clone, Debug)]
pub(in crate::web_access) struct SearchOutput {
    pub results: Vec<SearchResult>,
    pub provider_overview: Option<String>,
    pub duration_ms: u64,
    pub provider: String,
    pub search_requests: u64,
    pub search_warnings: Vec<String>,
    pub failed_queries: Vec<Value>,
}

pub(in crate::web_access) trait SearchProvider: Send + Sync {
    fn id(&self) -> &str;
    fn planned_concurrency(&self) -> Option<usize> {
        None
    }
    fn search<'a>(
        &'a self,
        access: &'a super::super::service::WebAccess,
        input: &'a SearchInput,
        cancellation: &'a CancellationToken,
    ) -> futures_util::future::BoxFuture<'a, Result<SearchOutput, WebAccessError>>;
}

impl SearchOutput {
    pub(super) fn direct(provider: &str, results: Vec<SearchResult>, duration_ms: u64) -> Self {
        Self {
            results,
            provider_overview: None,
            duration_ms,
            provider: provider.to_owned(),
            search_requests: 1,
            search_warnings: Vec::new(),
            failed_queries: Vec::new(),
        }
    }
}

pub(super) fn compact_domain(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_owned))
        .map(|host| host.strip_prefix("www.").unwrap_or(&host).to_owned())
        .unwrap_or_else(|| "unknown".into())
}

pub(super) fn matches_domains(url: &str, domains: &[String]) -> bool {
    domains.is_empty()
        || url::Url::parse(url)
            .ok()
            .and_then(|parsed| parsed.host_str().map(str::to_ascii_lowercase))
            .is_some_and(|host| {
                domains.iter().any(|domain| {
                    let domain = domain.trim().trim_start_matches('.').to_ascii_lowercase();
                    !domain.is_empty() && (host == domain || host.ends_with(&format!(".{domain}")))
                })
            })
}

pub(super) fn filter_results(
    mut results: Vec<SearchResult>,
    input: &SearchInput,
) -> Vec<SearchResult> {
    results.retain(|result| {
        matches_domains(&result.url, &input.allowed_domains)
            && (input.blocked_domains.is_empty()
                || !matches_domains(&result.url, &input.blocked_domains))
    });
    results.truncate(input.max_results);
    results
}
