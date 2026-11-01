//! The reader's render step (web_read) in the browser order: the attached
//! App, else the hidden App host (started for it), else the headless
//! browser. An App renders in a hidden page whose every request passes the
//! navigation guard; the URL is checked here before and after, too.
use super::{HttpState, PendingCall, hidden};
use butler_runtime::browser::{ContentOrigin, RenderFuture, RenderPort, Rendered, guard_url};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Weak},
    time::Duration,
};

/// Rendered pages larger than this are refused, never truncated.
const MAX_HTML: usize = 8 * 1024 * 1024;

pub(in crate::gateway::http) struct ReaderPort(pub Weak<HttpState>);

impl RenderPort for ReaderPort {
    fn host_attached(&self) -> bool {
        self.0.upgrade().is_some_and(|state| attached(&state))
    }

    fn render(&self, url: String, wait: Duration) -> RenderFuture {
        let state = self.0.clone();
        Box::pin(async move { render(&state.upgrade()?, &url, wait).await })
    }
}

fn attached(state: &HttpState) -> bool {
    state.browser.0.lock().is_ok_and(|hub| hub.host.is_some())
}

async fn render(
    state: &Arc<HttpState>,
    url: &str,
    wait: Duration,
) -> Option<Result<Rendered, &'static str>> {
    if !attached(state) {
        hidden::ensure(state, None).await;
    }
    if attached(state) {
        return Some(on_host(state, url, wait).await);
    }
    let headless = state.headless.clone().filter(|h| h.enabled())?;
    Some(headless.render(url, wait).await)
}

/// One render on the attached host (the App or the hidden App host).
async fn on_host(
    state: &Arc<HttpState>,
    url: &str,
    wait: Duration,
) -> Result<Rendered, &'static str> {
    // The headless browser's rule: public pages, and Butler's own outputs.
    let port = super::super::content::port(state);
    let content = Some(ContentOrigin(port));
    if !guard_url(url, content).await {
        return Err("navigation_denied");
    }
    let policy =
        butler_runtime::browser::navigation_policy(&format!("http://127.0.0.1:{port}"), url);
    let id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    {
        let mut hub = state.browser.0.lock().map_err(|_| "browser_unavailable")?;
        let wait_ms = u64::try_from(wait.as_millis()).unwrap_or(u64::MAX);
        let frame = json!({"id":id,"op":"reader.render","args":{"url":url,"wait_ms":wait_ms,"policy":policy}});
        let sent = hub
            .host
            .as_ref()
            .is_some_and(|host| host.try_send(frame).is_ok());
        if !sent {
            return Err("browser_unavailable");
        }
        hub.pending.insert(id.clone(), sender.into());
    }
    let _pending = PendingCall {
        state: state.clone(),
        id,
    };
    let reply = tokio::time::timeout(wait + Duration::from_secs(2), receiver)
        .await
        .map_err(|_| "render_timeout")?
        .map_err(|_| "browser_unavailable")?;
    rendered(&reply, content).await
}

async fn rendered(reply: &Value, content: Option<ContentOrigin>) -> Result<Rendered, &'static str> {
    use base64::Engine;
    match reply["status"].as_str() {
        Some("ok") => {}
        Some("navigation_denied") => return Err("navigation_denied"),
        _ => return Err("render_failed"),
    }
    let html = base64::engine::general_purpose::STANDARD
        .decode(reply["html_base64"].as_str().unwrap_or(""))
        .map_err(|_| "render_failed")?;
    if html.len() > MAX_HTML {
        return Err("render_too_large");
    }
    let final_url = reply["final_url"].as_str().unwrap_or("").to_owned();
    if !guard_url(&final_url, content).await {
        return Err("navigation_denied");
    }
    Ok(Rendered {
        final_url,
        status: reply["http_status"]
            .as_u64()
            .and_then(|s| u16::try_from(s).ok())
            .unwrap_or(200),
        html: String::from_utf8_lossy(&html).into_owned(),
    })
}
