use super::super::events::Decoder;
use crate::{BrowserHostEvents, Error, ShellClient};
use reqwest::Method;
use serde_json::Value;
use std::collections::VecDeque;

impl ShellClient {
    /// Publishes the native browser host's tab snapshot (local admin only).
    pub async fn browser_host_events(&self, body: &Value) -> Result<Value, Error> {
        self.admin_raw_json(
            Method::POST,
            &["internal", "browser-host", "events"],
            Some(body),
        )
        .await
    }

    /// Attaches as the page host of process `pid` (local admin only). The stream ends with
    /// the connection; a host already attached answers `Error::Http(409)`.
    pub async fn browser_host_attach(&self, pid: u32) -> Result<BrowserHostEvents, Error> {
        let headers = [
            ("x-butler-browser-host-kind", "pages".to_owned()),
            ("x-butler-app-pid", pid.to_string()),
        ];
        let response = self
            .admin_response(
                Method::GET,
                &["internal", "browser-host"],
                &headers,
                None,
                true,
            )
            .await?;
        let state = (response, Decoder::default(), VecDeque::new());
        Ok(Box::pin(futures_util::stream::unfold(
            Some(state),
            |state| async move {
                let (mut response, mut decoder, mut ready) = state?;
                loop {
                    if let Some(event) = ready.pop_front() {
                        return Some((Ok(event), Some((response, decoder, ready))));
                    }
                    match response.chunk().await {
                        Ok(Some(bytes)) => match decoder.frames(&bytes) {
                            Ok(frames) => ready.extend(frames),
                            Err(error) => return Some((Err(error), None)),
                        },
                        Ok(None) => return None,
                        Err(_) => return Some((Err(Error::Connection), None)),
                    }
                }
            },
        )))
    }

    /// Answers a page host call (local admin only).
    pub async fn browser_host_result(&self, id: &str, result: &Value) -> Result<(), Error> {
        self.admin_response(
            Method::POST,
            &["internal", "browser-host", "results", id],
            &[],
            Some(result),
            false,
        )
        .await
        .map(drop)
    }

    /// Sends raw DevTools messages of hosted pages (local admin only).
    pub async fn browser_host_cdp(&self, body: &Value) -> Result<(), Error> {
        self.admin_response(
            Method::POST,
            &["internal", "browser-host", "cdp"],
            &[],
            Some(body),
            false,
        )
        .await
        .map(drop)
    }

    /// Records committed native browser visits (local admin only).
    pub async fn browser_host_visits(&self, body: &Value) -> Result<Value, Error> {
        self.admin_raw_json(
            Method::POST,
            &["internal", "browser-host", "visits"],
            Some(body),
        )
        .await
    }

    /// Prepares or publishes a conversation download (local admin only).
    pub async fn browser_host_downloads(&self, body: &Value) -> Result<Value, Error> {
        self.admin_raw_json(
            Method::POST,
            &["internal", "browser-host", "downloads"],
            Some(body),
        )
        .await
    }
}
