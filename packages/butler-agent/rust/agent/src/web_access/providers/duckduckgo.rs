use std::time::Instant;

use futures_util::FutureExt;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::web_access::{
    search::parse_results,
    service::{WebAccess, WebAccessError},
};

use super::contracts::{SearchInput, SearchOutput, SearchProvider};

pub(super) struct DuckDuckGoHtmlSearchProvider {
    api_base: Option<String>,
}

impl DuckDuckGoHtmlSearchProvider {
    pub(super) fn new(api_base: Option<String>) -> Self {
        Self { api_base }
    }
}

impl SearchProvider for DuckDuckGoHtmlSearchProvider {
    fn id(&self) -> &'static str {
        "duckduckgo-html"
    }

    fn planned_concurrency(&self) -> Option<usize> {
        Some(2)
    }

    fn search<'a>(
        &'a self,
        access: &'a WebAccess,
        input: &'a SearchInput,
        cancellation: &'a CancellationToken,
    ) -> futures_util::future::BoxFuture<'a, Result<SearchOutput, WebAccessError>> {
        async move {
            let started = Instant::now();
            let mut url = match self.api_base.as_deref() {
                Some(base) => Url::parse(base).map_err(|_| {
                    WebAccessError::new(
                        "web_access_configuration_invalid",
                        "Search endpoint is invalid.",
                    )
                })?,
                None => access.search_url(&input.query),
            };
            if self.api_base.is_some() {
                url.query_pairs_mut().append_pair("q", &input.query);
            }
            let mut request = access
                .client()
                .get(url)
                .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml")
                .header(
                    reqwest::header::ACCEPT_LANGUAGE,
                    "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
                )
                .header(reqwest::header::USER_AGENT, "Mozilla/5.0 Butler/1.0");
            request = request.header(reqwest::header::ACCEPT_ENCODING, "gzip, deflate, br");
            let fetched = access.fetch_request_to_spool(request, cancellation).await?;
            let status = fetched.status;
            let results = tokio::task::spawn_blocking({
                let input = input.clone();
                move || {
                    let bytes = fetched.read_all().map_err(|_| {
                        WebAccessError::new(
                            "web_access_spool_failed",
                            "Search response could not be read.",
                        )
                    })?;
                    let html = String::from_utf8_lossy(&bytes);
                    if !(200..300).contains(&status) {
                        return Err(WebAccessError::new(
                            "web_search_request_failed",
                            format!("DuckDuckGo search failed with HTTP {status}."),
                        ));
                    }
                    if crate::web_access::search::is_duckduckgo_challenge(&html) {
                        return Err(WebAccessError::new(
                            "web_search_challenge",
                            "DuckDuckGo returned an anti-bot challenge page.",
                        ));
                    }
                    Ok(parse_results(
                        &html,
                        input.max_results,
                        &input.allowed_domains,
                        &input.blocked_domains,
                    ))
                }
            })
            .await
            .map_err(|_| {
                WebAccessError::new(
                    "web_search_parse_failed",
                    "Search response could not be parsed.",
                )
            })??;
            Ok(SearchOutput::direct(
                self.id(),
                results,
                started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
            ))
        }
        .boxed()
    }
}
