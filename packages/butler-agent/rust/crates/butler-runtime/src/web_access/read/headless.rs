//! The reader's render step on Butler's own headless browser (#171), used
//! when Lightpanda is not installed and the browser is on: the page renders
//! behind the browser's navigation guard and egress proxy.
use std::time::Duration;

use crate::web_access::WebAccessCode;
use crate::web_access::{
    page::{PageRead, extract_page},
    service::WebAccessError,
};

pub(super) async fn render(
    url: &url::Url,
    requested_url: &str,
) -> Result<Option<PageRead>, WebAccessError> {
    let Some(browser) = crate::browser::headless_reader() else {
        return Ok(None);
    };
    let Ok(rendered) = browser.render(url.as_str(), Duration::from_secs(20)).await else {
        return Ok(None);
    };
    let requested = requested_url.to_owned();
    let mut page = tokio::task::spawn_blocking(move || {
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
    })??;
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
