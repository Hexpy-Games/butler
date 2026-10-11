use reqwest::Url;
use tokio::{fs::File as TokioFile, io::AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use super::{WebAccess, WebAccessError};
use crate::web_access::WebAccessCode;
use crate::web_access::spool::{FetchedBody, TemporarySpool};

/// Where a logical page URL is fetched from, and which URL the page reports
/// once the response settles.
pub(crate) trait PageRoute: Send + Sync {
    fn request_url(&self, logical: &Url) -> Url;
    fn settled_url(&self, logical: Url, response_url: &str) -> Option<Url>;
}

/// Fetches the logical URL itself and reports where redirects ended.
pub(crate) struct DirectPageRoute;

impl PageRoute for DirectPageRoute {
    fn request_url(&self, logical: &Url) -> Url {
        logical.clone()
    }

    fn settled_url(&self, _logical: Url, response_url: &str) -> Option<Url> {
        Url::parse(response_url).ok()
    }
}

impl WebAccess {
    pub(in crate::web_access) async fn fetch_page_to_spool(
        &self,
        logical_url: Url,
        accept: &'static str,
        cancellation: &CancellationToken,
    ) -> Result<(FetchedBody, Url), WebAccessError> {
        let route = &self.inner.page_route;
        let request_url = route.request_url(&logical_url);
        if !self.page_permitted(&request_url) {
            return Err(WebAccessError::new(
                WebAccessCode::WebAccessRequestFailed,
                "Page address is not public.",
            ));
        }
        let request = self
            .inner
            .page_client
            .get(request_url)
            .header(reqwest::header::ACCEPT, accept)
            .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.8,ko;q=0.6");
        let fetched = self.fetch_request_to_spool(request, cancellation).await?;
        let final_url = route
            .settled_url(logical_url, &fetched.final_url)
            .ok_or_else(|| {
                WebAccessError::new(
                    WebAccessCode::WebAccessResponseFailed,
                    "Public response URL was invalid.",
                )
            })?;
        Ok((fetched, final_url))
    }

    pub(in crate::web_access) async fn fetch_request_to_spool(
        &self,
        request: reqwest::RequestBuilder,
        cancellation: &CancellationToken,
    ) -> Result<FetchedBody, WebAccessError> {
        if cancellation.is_cancelled() {
            return Err(WebAccessError::cancelled());
        }
        let response = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(WebAccessError::cancelled()),
            result = request.send() => result.map_err(|source| WebAccessError::new(WebAccessCode::WebAccessRequestFailed, "Public web request failed.").with_source(source))?,
        };
        let status = response.status().as_u16();
        let ok = response.status().is_success();
        let final_url = response.url().to_string();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let (spool, file) = TemporarySpool::create(&self.inner.data_root).map_err(|source| {
            WebAccessError::new(
                WebAccessCode::WebAccessSpoolFailed,
                "Public page could not be spooled in DATA.",
            )
            .with_source(source)
        })?;
        let mut file = TokioFile::from_std(file);
        let mut stream = response.bytes_stream();
        loop {
            let next = tokio::select! {
                biased;
                () = cancellation.cancelled() => return Err(WebAccessError::cancelled()),
                chunk = futures_util::StreamExt::next(&mut stream) => chunk,
            };
            let Some(chunk) = next else { break };
            let chunk = chunk.map_err(|source| {
                WebAccessError::new(
                    WebAccessCode::WebAccessResponseFailed,
                    "Public response body failed.",
                )
                .with_source(source)
            })?;
            file.write_all(&chunk).await.map_err(|source| {
                WebAccessError::new(
                    WebAccessCode::WebAccessSpoolFailed,
                    "Public page could not be spooled in DATA.",
                )
                .with_source(source)
            })?;
        }
        file.flush().await.map_err(|source| {
            WebAccessError::new(
                WebAccessCode::WebAccessSpoolFailed,
                "Public page could not be spooled in DATA.",
            )
            .with_source(source)
        })?;
        drop(file);
        Ok(FetchedBody {
            final_url,
            status,
            ok,
            content_type,
            spool,
        })
    }
}
