//! The reader's render step (#171) on the headless browser: a public page
//! loads in a fresh hidden page behind the navigation guard and the egress
//! proxy, settles, and its rendered HTML comes back for extraction.
use super::{
    Headless,
    hidden::{HiddenPage, Purpose},
};
use crate::browser::egress::guard_url;
use std::time::Duration;

/// Rendered pages larger than this are refused, never truncated.
const MAX_HTML: usize = 8 * 1024 * 1024;

/// The headless browser serving this process's reader renders (#171).
static READER: std::sync::Mutex<Option<std::sync::Weak<Headless>>> = std::sync::Mutex::new(None);

pub(super) fn register(headless: &std::sync::Arc<Headless>) {
    *READER
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) =
        Some(std::sync::Arc::downgrade(headless));
}

/// The registered headless browser, while it is on.
pub fn reader() -> Option<std::sync::Arc<Headless>> {
    READER
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .and_then(std::sync::Weak::upgrade)
        .filter(|h| h.enabled())
}

/// A rendered page: where it settled, its HTTP status and its HTML.
pub struct Rendered {
    pub final_url: String,
    pub status: u16,
    pub html: String,
}

const SETTLE: &str = "new Promise(done=>{let timer;const end=()=>{observer.disconnect();clearTimeout(cap);done(true)};
  const observer=new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(end,500)});
  observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
  timer=setTimeout(end,500);const cap=setTimeout(end,3000)})";

impl Headless {
    /// Renders `url` for the reader. `Err` names why nothing was rendered.
    pub async fn render(
        self: &std::sync::Arc<Self>,
        url: &str,
        wait: Duration,
    ) -> Result<Rendered, &'static str> {
        if !self.enabled() {
            return Err("headless_disabled");
        }
        if !guard_url(url, self.config.content).await {
            return Err("navigation_denied");
        }
        let browser = self.ready().await.map_err(|_| "browser_unavailable")?;
        let hidden = HiddenPage::open(&browser, Purpose::Render)
            .await
            .map_err(|_| "browser_unavailable")?;
        let result = tokio::time::timeout(wait, read(&hidden, url, self.config.content))
            .await
            .unwrap_or(Err("render_timeout"));
        hidden.close().await;
        result
    }
}

async fn read(
    hidden: &HiddenPage,
    url: &str,
    content: Option<crate::browser::ContentOrigin>,
) -> Result<Rendered, &'static str> {
    let navigated = hidden.navigate(url, Duration::from_secs(15)).await;
    if hidden.diagnostics(|d| d.denied).unwrap_or(false) {
        return Err("navigation_denied");
    }
    navigated.map_err(|_| "render_failed")?;
    let context = hidden
        .page
        .world(&hidden.page.session, &hidden.page.target)
        .await
        .map_err(|_| "render_failed")?;
    let _ = hidden
        .page
        .evaluate_in(&hidden.page.session, context, SETTLE)
        .await;
    let page = hidden
        .page
        .evaluate_in(
            &hidden.page.session,
            context,
            "({url:location.href,html:document.documentElement.outerHTML})",
        )
        .await
        .map_err(|_| "render_failed")?;
    let html = page["html"].as_str().unwrap_or("").to_owned();
    if html.len() > MAX_HTML {
        return Err("render_too_large");
    }
    let final_url = page["url"].as_str().unwrap_or(url).to_owned();
    if !guard_url(&final_url, content).await {
        return Err("navigation_denied");
    }
    let status = hidden.diagnostics(|d| d.status).flatten().unwrap_or(200);
    Ok(Rendered {
        final_url,
        status,
        html,
    })
}
