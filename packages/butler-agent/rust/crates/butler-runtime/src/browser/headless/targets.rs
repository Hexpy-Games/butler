//! Page targets: conversation tabs in their own in-memory browser context,
//! popups in their opener's group, out-of-process frames, and the guard on
//! every frame document request.
use super::{
    browser::Browser,
    cdp::Cdp,
    state::{Shared, Tab},
};
use crate::browser::egress::{guard_preview_url, guard_url};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
mod attach;
pub(crate) use attach::page_attached;

pub(crate) const VIEWPORT: (u32, u32) = (1280, 800);
/// Domains, guard, fixed layout and dialog/chooser interception, then the
/// paused target runs.
pub(crate) async fn setup_page(cdp: &Cdp, session: &str) -> Result<(), String> {
    for (method, params) in [
        ("Page.enable", json!({})),
        ("Runtime.enable", json!({})),
        ("Network.enable", json!({})),
        (
            "Fetch.enable",
            json!({"patterns":[{"resourceType":"Document","requestStage":"Request"}]}),
        ),
        (
            "Target.setAutoAttach",
            json!({"autoAttach":true,"waitForDebuggerOnStart":true,"flatten":true}),
        ),
        (
            "Emulation.setDeviceMetricsOverride",
            json!({"width":VIEWPORT.0,"height":VIEWPORT.1,"deviceScaleFactor":1,"mobile":false}),
        ),
        (
            "Emulation.setFocusEmulationEnabled",
            json!({"enabled":true}),
        ),
        (
            "Page.setInterceptFileChooserDialog",
            json!({"enabled":true}),
        ),
        ("Runtime.runIfWaitingForDebugger", json!({})),
    ] {
        cdp.send(method, params, Some(session)).await?;
    }
    Ok(())
}

async fn setup_frame(cdp: &Cdp, session: &str) -> Result<(), String> {
    for (method, params) in [
        ("Page.enable", json!({})),
        ("Runtime.enable", json!({})),
        ("Network.enable", json!({})),
        (
            "Fetch.enable",
            json!({"patterns":[{"resourceType":"Document","requestStage":"Request"}]}),
        ),
        (
            "Target.setAutoAttach",
            json!({"autoAttach":true,"waitForDebuggerOnStart":true,"flatten":true}),
        ),
        ("Runtime.runIfWaitingForDebugger", json!({})),
    ] {
        cdp.send(method, params, Some(session)).await?;
    }
    Ok(())
}

/// The session of a page target this call created, once it attached.
pub(crate) async fn claim(shared: &Shared, target: &str) -> Option<String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let waiting = shared.attached.notified();
        if let Some(session) = shared.lock().unclaimed.remove(target) {
            return Some(session);
        }
        if tokio::time::timeout_at(deadline, waiting).await.is_err() {
            return None;
        }
    }
}

/// A conversation's in-memory browser context, created on its first tab.
/// A registered preview gets its own context behind the preview proxy, as the
/// App gives it its own partition.
pub(crate) async fn context(
    browser: &Browser,
    owner: &str,
    preview: Option<&str>,
) -> Result<String, String> {
    let (key, proxy) = match preview {
        Some(id) => (
            format!("{owner}:preview:{id}"),
            browser
                .preview_proxy_url
                .clone()
                .ok_or("navigation_denied")?,
        ),
        None => (owner.to_owned(), browser.proxy_url.clone()),
    };
    if let Some(id) = browser.shared.lock().contexts.get(&key).cloned() {
        return Ok(id);
    }
    let _creating = browser.contexts_created.lock().await;
    if let Some(id) = browser.shared.lock().contexts.get(&key).cloned() {
        return Ok(id);
    }
    let created = browser
        .cdp
        .send(
            "Target.createBrowserContext",
            json!({"disposeOnDetach":true,"proxyServer":proxy,"proxyBypassList":"<-loopback>"}),
            None,
        )
        .await?;
    let id = created["browserContextId"]
        .as_str()
        .ok_or("browser_unavailable")?
        .to_owned();
    // Conversation downloads land in a stage, then in the workspace (#745).
    let behavior = if browser.downloads.available() {
        json!({"behavior":"allowAndName","browserContextId":id,"downloadPath":browser.downloads.stage,"eventsEnabled":true})
    } else {
        json!({"behavior":"deny","browserContextId":id})
    };
    let _ = browser
        .cdp
        .send("Browser.setDownloadBehavior", behavior, None)
        .await;
    browser.shared.lock().contexts.insert(key, id.clone());
    Ok(id)
}
/// Creates a paused blank page in `context` and returns (target, session).
pub(crate) async fn create(
    cdp: &Cdp,
    shared: &Shared,
    context: &str,
) -> Result<(String, String), String> {
    shared.lock().creating += 1;
    // Width/height apply only to a new window (CEF reuses one otherwise; the headless shell always makes one).
    let created = cdp
        .send("Target.createTarget", json!({"url":"about:blank","browserContextId":context,"width":VIEWPORT.0,"height":VIEWPORT.1,"background":true,"newWindow":true}), None)
        .await;
    let session = match &created {
        Ok(created) => claim(shared, created["targetId"].as_str().unwrap_or("")).await,
        Err(_) => None,
    };
    shared.lock().creating -= 1;
    let target = created?["targetId"].as_str().unwrap_or("").to_owned();
    let Some(session) = session else {
        let _ = cdp
            .send("Target.closeTarget", json!({"targetId":target}), None)
            .await;
        return Err("browser_unavailable".into());
    };
    Ok((target, session))
}

/// The Butler-owned page that draws marks and encodes images.
pub(crate) async fn utility(cdp: &Arc<Cdp>, shared: &Shared) -> Result<String, String> {
    if let Some(session) = shared.lock().utility.clone() {
        return Ok(session);
    }
    let created = cdp
        .send(
            "Target.createBrowserContext",
            json!({"disposeOnDetach":true}),
            None,
        )
        .await?;
    let context = created["browserContextId"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    let (_, session) = create(cdp, shared, &context).await?;
    cdp.send("Runtime.runIfWaitingForDebugger", json!({}), Some(&session))
        .await?;
    let mut state = shared.lock();
    if let Some(existing) = state.utility.clone() {
        return Ok(existing);
    }
    state.utility = Some(session.clone());
    Ok(session)
}

/// Room for one more conversation tab: when every tab memory allows is open,
/// the least recently used idle one closes first. False only while every tab
/// is in use.
pub(crate) async fn make_room(browser: &Browser, keep: &[&str], turn: Option<&str>) -> bool {
    let limit = crate::browser::capacity::agent_tabs();
    let victim = {
        let state = browser.shared.lock();
        if state.agent_tabs() < limit {
            return true;
        }
        state.reclaimable(keep, turn)
    };
    let Some(victim) = victim else {
        return false;
    };
    close(browser, &victim).await;
    browser.shared.lock().agent_tabs() < limit
}

/// Closes a tab's target and forgets it; a conversation's context goes with its last tab.
pub(crate) async fn close(browser: &Browser, id: &str) {
    let removed = { browser.shared.lock().remove(id) };
    browser.changed.notify_waiters();
    let Some(tab) = removed else {
        return;
    };
    let _ = browser
        .cdp
        .send("Target.closeTarget", json!({"targetId":tab.target}), None)
        .await;
    forget(browser, &tab).await;
}

/// A conversation's (or preview's) in-memory context ends with its last tab,
/// as the App clears a conversation partition.
pub(crate) async fn forget(browser: &Browser, tab: &Tab) {
    let owner_left = {
        let mut state = browser.shared.lock();
        let left = !state.tabs.values().any(|t| t.context == tab.context);
        if left {
            state.contexts.retain(|_, id| *id != tab.context);
        }
        left
    };
    if owner_left && !tab.context.is_empty() {
        let _ = browser
            .cdp
            .send(
                "Target.disposeBrowserContext",
                json!({"browserContextId":tab.context}),
                None,
            )
            .await;
    }
}

fn web_url(raw: &str) -> Option<url::Url> {
    url::Url::parse(raw).ok().filter(|u| {
        matches!(u.scheme(), "http" | "https") && u.username().is_empty() && u.password().is_none()
    })
}

/// Release-maintained auth/utility policy for agent popups (`popup-policy.mjs`).
pub(crate) fn popup_allowed(policy: &Value, parent: &str, raw: &str) -> bool {
    let Some(target) = web_url(raw) else {
        return raw == "about:blank";
    };
    let host = target.host_str().unwrap_or("");
    let same_origin = web_url(parent).is_some_and(|p| p.origin() == target.origin());
    let in_list = |key: &str, test: &dyn Fn(&str) -> bool| {
        policy[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .any(test)
    };
    same_origin
        || in_list("popup_sites", &|site| {
            host == site || host.ends_with(&format!(".{site}"))
        })
        || in_list("popup_hosts", &|h| h == host)
}

/// A page, frame or worker attached to the browser or to one of its tabs.
pub(crate) async fn attached(browser: Arc<Browser>, parent: Option<String>, params: Value) {
    let session = params["sessionId"].as_str().unwrap_or("").to_owned();
    let info = &params["targetInfo"];
    let target = info["targetId"].as_str().unwrap_or("").to_owned();
    let kind = info["type"].as_str().unwrap_or("");
    if super::identity::apply(&browser.cdp, &session, kind)
        .await
        .is_err()
    {
        let _ = browser
            .cdp
            .send("Target.closeTarget", json!({"targetId":target}), None)
            .await;
        return;
    }
    match kind {
        "iframe" => {
            let tab = parent
                .as_deref()
                .and_then(|p| browser.shared.lock().tab_of_session(p));
            if let Some(tab) = tab {
                {
                    let mut state = browser.shared.lock();
                    state.sessions.insert(session.clone(), tab.clone());
                    if let Some(entry) = state.tabs.get_mut(&tab) {
                        entry.frames.insert(target, session.clone());
                    }
                }
                let _ = setup_frame(&browser.cdp, &session).await;
            } else {
                let _ = browser
                    .cdp
                    .send("Runtime.runIfWaitingForDebugger", json!({}), Some(&session))
                    .await;
            }
        }
        "worker" | "shared_worker" | "service_worker" => {
            let _ = browser
                .cdp
                .send("Runtime.runIfWaitingForDebugger", json!({}), Some(&session))
                .await;
        }
        "page" => page_attached(browser, session, target, info).await,
        _ => {
            if kind == "other" {
                super::events::hold_other(browser, parent, target, session);
                return;
            }
            let _ = browser
                .cdp
                .send("Runtime.runIfWaitingForDebugger", json!({}), Some(&session))
                .await;
            let _ = browser
                .cdp
                .send(
                    "Target.detachFromTarget",
                    json!({"sessionId":session}),
                    parent.as_deref(),
                )
                .await;
        }
    }
}

/// The guard on every frame document a tab requests: a request outside policy
/// fails, and only the tab's own page leaving policy closes the tab.
pub(crate) async fn guard(browser: Arc<Browser>, session: String, params: Value) {
    let request = params["requestId"].clone();
    let url = params["request"]["url"].as_str().unwrap_or("").to_owned();
    if super::hidden::answer(&browser, &session, &params).await {
        return;
    }
    let facts = {
        let state = browser.shared.lock();
        state
            .tab_of_session(&session)
            .and_then(|id| state.tabs.get(&id))
            .map(|t| {
                let main = params["frameId"] == t.target.as_str();
                (
                    t.id.clone(),
                    main,
                    main && t.opener.is_some(),
                    t.popup_parent_url.clone().unwrap_or_default(),
                    t.policy.clone(),
                )
            })
    };
    let Some((tab, main, popup, parent, policy)) = facts else {
        let _ = browser
            .cdp
            .send(
                "Fetch.failRequest",
                json!({"requestId":request,"errorReason":"BlockedByClient"}),
                Some(&session),
            )
            .await;
        return;
    };
    let popup_violation = popup && !popup_allowed(&policy, &parent, &url);
    let admitted = if policy["preview"] == true {
        guard_preview_url(&url, browser.content).await
    } else {
        guard_url(&url, browser.content).await
    };
    if !popup_violation && admitted {
        let _ = browser
            .cdp
            .send(
                "Fetch.continueRequest",
                json!({"requestId":request}),
                Some(&session),
            )
            .await;
        return;
    }
    let _ = browser
        .cdp
        .send(
            "Fetch.failRequest",
            json!({"requestId":request,"errorReason":"BlockedByClient"}),
            Some(&session),
        )
        .await;
    if !main {
        return;
    }
    {
        let mut state = browser.shared.lock();
        if popup_violation {
            state.event(
                &tab,
                "popup_blocked",
                &json!({"url":url,"reason":"popup_policy"}),
            );
        }
        if let Some(entry) = state.tabs.get_mut(&tab) {
            entry.changed();
        }
    }
    let _ = browser
        .cdp
        .send("Page.stopLoading", json!({}), Some(&session))
        .await;
    close(&browser, &tab).await;
}
