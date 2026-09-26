use reqwest::Url;
use tokio::{fs::File as TokioFile, io::AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use super::{WebAccess, WebAccessError};
use crate::web_access::spool::{FetchedBody, TemporarySpool};

impl WebAccess {
    pub(in crate::web_access) async fn fetch_to_spool(
        &self,
        url: Url,
        accept: &'static str,
        cancellation: &CancellationToken,
    ) -> Result<FetchedBody, WebAccessError> {
        let request = self
            .inner
            .client
            .get(url)
            .header(reqwest::header::ACCEPT, accept)
            .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.8,ko;q=0.6");
        self.fetch_request_to_spool(request, cancellation).await
    }

    pub(in crate::web_access) async fn fetch_page_to_spool(
        &self,
        logical_url: Url,
        accept: &'static str,
        cancellation: &CancellationToken,
    ) -> Result<(FetchedBody, Url), WebAccessError> {
        #[cfg(test)]
        let request_url = self
            .inner
            .page_test_endpoint
            .as_ref()
            .map(|base| super::test_page_url(base, &logical_url))
            .unwrap_or_else(|| logical_url.clone());
        #[cfg(not(test))]
        let request_url = logical_url.clone();
        let test_override = request_url != logical_url;
        let fetched = self
            .fetch_to_spool(request_url, accept, cancellation)
            .await?;
        let final_url = if test_override {
            logical_url
        } else {
            Url::parse(&fetched.final_url).map_err(|_| {
                WebAccessError::new(
                    "web_access_response_failed",
                    "Public response URL was invalid.",
                )
            })?
        };
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
            _ = cancellation.cancelled() => return Err(WebAccessError::cancelled()),
            result = request.send() => result.map_err(|_| {
                WebAccessError::new("web_access_request_failed", "Public web request failed.")
            })?,
        };
        let status = response.status().as_u16();
        let ok = response.status().is_success();
        let final_url = response.url().to_string();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let mut spool = TemporarySpool::create(&self.inner.data_root).map_err(|_| {
            WebAccessError::new(
                "web_access_spool_failed",
                "Public page could not be spooled in DATA.",
            )
        })?;
        let mut file = TokioFile::from_std(spool.open_file.take().expect("new spool file"));
        let mut stream = response.bytes_stream();
        loop {
            let next = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(WebAccessError::cancelled()),
                chunk = futures_util::StreamExt::next(&mut stream) => chunk,
            };
            let Some(chunk) = next else { break };
            let chunk = chunk.map_err(|_| {
                WebAccessError::new("web_access_response_failed", "Public response body failed.")
            })?;
            file.write_all(&chunk).await.map_err(|_| {
                WebAccessError::new(
                    "web_access_spool_failed",
                    "Public page could not be spooled in DATA.",
                )
            })?;
        }
        file.flush().await.map_err(|_| {
            WebAccessError::new(
                "web_access_spool_failed",
                "Public page could not be spooled in DATA.",
            )
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
