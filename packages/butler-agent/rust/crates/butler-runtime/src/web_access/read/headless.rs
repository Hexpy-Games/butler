//! Reads in Butler's browser: the App's browser (attached or the hidden App
//! host), else Butler's headless browser, each behind its navigation guard.
//! The `browser` reader mode reads here first; `auto`/`lightpanda` render
//! here when Lightpanda is not installed (#171).
use std::time::Duration;

use crate::web_access::WebAccessCode;
use crate::web_access::{
    page::{PageRead, extract_page},
    service::WebAccessError,
};

/// The `browser` reader: the page as Butler's browser renders it, or `None`
/// when no browser served it or it rendered nothing readable. The wait
/// leaves the lightweight fetch time inside the read's budget.
pub(super) async fn browser(
    url: &url::Url,
    requested_url: &str,
) -> Result<Option<PageRead>, WebAccessError> {
    let Some(mut page) = rendered(url, requested_url, Duration::from_secs(12)).await? else {
        return Ok(None);
    };
    if !page.ok || page.text.trim().is_empty() {
        return Ok(None);
    }
    page.reader = "butler-browser".into();
    Ok(Some(page))
}

pub(super) async fn render(
    url: &url::Url,
    requested_url: &str,
) -> Result<Option<PageRead>, WebAccessError> {
    let Some(mut page) = rendered(url, requested_url, Duration::from_secs(20)).await? else {
        return Ok(None);
    };
    page.reader = "headless".into();
    if !page
        .warnings
        .iter()
        .any(|w| w == "headless-rendered-fallback-used")
    {
        page.warnings.push("headless-rendered-fallback-used".into());
        page.warnings.sort();
    }
    Ok(Some(page))
}

async fn rendered(
    url: &url::Url,
    requested_url: &str,
    wait: Duration,
) -> Result<Option<PageRead>, WebAccessError> {
    // The App's browser (attached or hidden) when there is one, else headless.
    let Some(Ok(rendered)) = crate::browser::reader_render(url.as_str(), wait).await else {
        return Ok(None);
    };
    let requested = requested_url.to_owned();
    tokio::task::spawn_blocking(move || {
        let ok = (200..400).contains(&rendered.status);
        extract_page(
            &requested,
            &rendered.final_url,
            rendered.status,
            ok,
            Some("text/html; charset=utf-8"),
            rendered.html.as_bytes(),
            "headless",
        )
    })
    .await
    .map_err(|source| {
        WebAccessError::new(
            WebAccessCode::WebReadParseFailed,
            "Rendered page could not be parsed.",
        )
        .with_source(source)
    })?
    .map(Some)
}
