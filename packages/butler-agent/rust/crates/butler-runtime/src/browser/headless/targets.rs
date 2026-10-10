//! Page targets: conversation tabs in their own in-memory browser context,
//! popups in their opener's group, out-of-process frames, and the guard on
//! every frame document request.
use super::{
    browser::Browser,
    cdp::Cdp,
    state::{Shared, Tab, short_id},
};
use crate::browser::egress::guard_url;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

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
pub(crate) async fn context(browser: &Browser, owner: &str) -> Result<String, String> {
    if let Some(id) = browser.shared.lock().contexts.get(owner).cloned() {
        return Ok(id);
    }
    let created = browser
        .cdp
        .send("Target.createBrowserContext", json!({"disposeOnDetach":true,"proxyServer":browser.proxy_url,"proxyBypassList":"<-loopback>"}), None)
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
    browser
        .shared
        .lock()
        .contexts
        .insert(owner.to_owned(), id.clone());
    Ok(id)
}

/// Creates a paused blank page in `context` and returns (target, session).
pub(crate) async fn create(
    cdp: &Cdp,
    shared: &Shared,
    context: &str,
) -> Result<(String, String), String> {
    shared.lock().creating += 1;
    let created = cdp
        .send("Target.createTarget", json!({"url":"about:blank","browserContextId":context,"width":VIEWPORT.0,"height":VIEWPORT.1,"background":true}), None)
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

/// A conversation's in-memory context ends with its last tab, as the App
/// clears a conversation partition.
pub(crate) async fn forget(browser: &Browser, tab: &Tab) {
    let owner_left = {
        let mut state = browser.shared.lock();
        let left = !state.tabs.values().any(|t| t.owner == tab.owner);
        if left {
            state.contexts.remove(&tab.owner);
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
    match info["type"].as_str().unwrap_or("") {
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
        "page" => page_attached(browser, session, target, info).await,
        _ => {
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

async fn page_attached(browser: Arc<Browser>, session: String, target: String, info: &Value) {
    let opener = info["openerId"].as_str().and_then(|opener| {
        let state = browser.shared.lock();
        state.tabs.values().find(|t| t.target == opener).map(|t| {
            (
                t.id.clone(),
                t.owner.clone(),
                t.url.clone(),
                t.policy.clone(),
                t.context.clone(),
            )
        })
    });
    let Some((opener, owner, parent_url, policy, context)) = opener else {
        let claimed = {
            let mut state = browser.shared.lock();
            let creating = state.creating > 0;
            if creating {
                state.unclaimed.insert(target.clone(), session);
            }
            creating
        };
        if claimed {
            browser.shared.attached.notify_waiters();
        } else {
            let _ = browser
                .cdp
                .send("Target.closeTarget", json!({"targetId":target}), None)
                .await;
        }
        return;
    };
    let url = info["url"].as_str().unwrap_or("").to_owned();
    let admitted = {
        let mut state = browser.shared.lock();
        let peers = state.tabs.values().filter(|t| t.owner == owner).count();
        if state.tabs.len() >= 6 || peers >= 3 {
            let site = web_url(&parent_url)
                .map(|u| u.origin().ascii_serialization())
                .unwrap_or_default();
            state.event(
                &opener,
                "popup_blocked",
                &json!({"url":url,"site":site,"reason":"tab_budget_exhausted"}),
            );
            None
        } else {
            let id = short_id('h', |id| state.tabs.contains_key(id));
            let mut tab = Tab::new(id.clone(), owner, target.clone(), session.clone());
            tab.opener = Some(opener.clone());
            tab.popup_parent_url = Some(parent_url);
            tab.policy = policy;
            tab.context = context;
            tab.url = web_url(&url).map(|u| u.to_string()).unwrap_or_default();
            state.tabs.insert(id.clone(), tab);
            state.sessions.insert(session.clone(), id.clone());
            state.event(&opener, "popup_opened", &json!({"popup":id,"url":url}));
            Some(id)
        }
    };
    browser.changed.notify_waiters();
    if admitted.is_none() {
        let _ = browser
            .cdp
            .send("Target.closeTarget", json!({"targetId":target}), None)
            .await;
        return;
    }
    if setup_page(&browser.cdp, &session).await.is_err()
        && let Some(id) = admitted
    {
        close(&browser, &id).await;
    }
}

/// The guard on every frame document a tab requests: a violation closes the tab.
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
                    main && t.opener.is_some(),
                    t.popup_parent_url.clone().unwrap_or_default(),
                    t.policy.clone(),
                )
            })
    };
    let Some((tab, popup, parent, policy)) = facts else {
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
    if !popup_violation && guard_url(&url, browser.content).await {
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
