//! Browser events applied to tab state in arrival order. Work that needs the
//! browser again (attaching, the guard, file choosers) runs on its own task.
use super::{browser::Browser, cdp::Event, dialogs, targets};
use serde_json::{Value, json};
use std::{sync::Arc, time::Instant};
use tokio::sync::mpsc;

pub(crate) async fn run(browser: Arc<Browser>, mut events: mpsc::UnboundedReceiver<Event>) {
    while let Some(event) = events.recv().await {
        apply(&browser, event);
    }
    // The pipe ended: the browser exited or was stopped.
    browser.alive.cancel();
    browser.shared.lock().tabs.clear();
    browser.changed.notify_waiters();
}

fn apply(browser: &Arc<Browser>, event: Event) {
    let Event {
        method,
        params,
        session,
    } = event;
    match method.as_str() {
        "Target.attachedToTarget" => {
            drop(tokio::spawn(targets::attached(
                browser.clone(),
                session,
                params,
            )));
        }
        "Target.detachedFromTarget" => detached(browser, &params),
        "Target.targetDestroyed" => destroyed(browser, params["targetId"].as_str().unwrap_or("")),
        "Target.targetInfoChanged" => info_changed(browser, &params["targetInfo"]),
        "Browser.downloadWillBegin" | "Browser.downloadProgress" => {
            browser.downloads.queue(&method, params);
        }
        "Target.targetCrashed" => crashed(browser, params["targetId"].as_str().unwrap_or("")),
        "Fetch.requestPaused" => {
            if let Some(session) = session {
                drop(tokio::spawn(targets::guard(
                    browser.clone(),
                    session,
                    params,
                )));
            }
        }
        "Page.javascriptDialogOpening" => {
            if let Some(session) = session {
                dialogs::opening(browser, &session, &params);
            }
        }
        "Page.javascriptDialogClosed" => {
            if let Some(session) = session {
                dialogs::closed(browser, &session);
            }
        }
        "Page.fileChooserOpened" => {
            if let Some(session) = session {
                chooser(browser, session, &params);
            }
        }
        _ => {
            if let Some(session) = session {
                tab_event(browser, &session, &method, &params);
                super::history::event(browser, &session, &method, &params);
            }
        }
    }
}

fn tab_event(browser: &Browser, session: &str, method: &str, params: &Value) {
    let mut state = browser.shared.lock();
    let Some(id) = state.tab_of_session(session) else {
        return;
    };
    let Some(tab) = state.tabs.get_mut(&id) else {
        return;
    };
    if let Some(diagnostics) = tab.diagnostics.as_mut() {
        diagnostics.event(method, params, &tab.target);
    }
    tab.devtools
        .event(method, params, (session == tab.session, &tab.target));
    let main = |frame: &Value| frame == tab.target.as_str();
    match method {
        "Page.frameNavigated" | "Page.navigatedWithinDocument" => tab.changed(),
        "Page.frameStartedLoading" if main(&params["frameId"]) => tab.loading = true,
        "Page.frameStoppedLoading" if main(&params["frameId"]) => tab.loading = false,
        "Page.loadEventFired" if session == tab.session => {
            tab.loads.send_modify(|n| *n += 1);
        }
        "Page.domContentEventFired" if session == tab.session => {
            tab.parsed.send_modify(|n| *n += 1);
        }
        "Network.requestWillBeSent" if matches!(params["type"].as_str(), Some("XHR" | "Fetch")) => {
            tab.requests.insert(
                params["requestId"].as_str().unwrap_or("").to_owned(),
                Instant::now(),
            );
        }
        "Network.loadingFinished" | "Network.loadingFailed" => {
            tab.requests
                .remove(params["requestId"].as_str().unwrap_or(""));
        }
        "Runtime.executionContextCreated" if params["context"]["name"] == "butler-browser" => {
            let frame = params["context"]["auxData"]["frameId"]
                .as_str()
                .unwrap_or("")
                .to_owned();
            if let Some(id) = params["context"]["id"].as_i64() {
                tab.contexts.insert((session.to_owned(), frame), id);
            }
        }
        "Runtime.executionContextDestroyed" => {
            let gone = params["executionContextId"].as_i64();
            tab.contexts
                .retain(|(s, _), id| s != session || Some(*id) != gone);
        }
        "Runtime.executionContextsCleared" => tab.contexts.retain(|(s, _), _| s != session),
        _ => {}
    }
}

fn detached(browser: &Arc<Browser>, params: &Value) {
    let session = params["sessionId"].as_str().unwrap_or("");
    let mut state = browser.shared.lock();
    let Some(id) = state.tab_of_session(session) else {
        return;
    };
    let main = state.tabs.get(&id).is_some_and(|t| t.session == session);
    if main {
        if let Some(tab) = state.remove(&id) {
            drop(state);
            gone(browser, tab);
        }
        return;
    }
    state.sessions.remove(session);
    if let Some(tab) = state.tabs.get_mut(&id) {
        tab.frames.retain(|_, s| s != session);
        tab.contexts.retain(|(s, _), _| s != session);
    }
}

fn destroyed(browser: &Arc<Browser>, target: &str) {
    let mut state = browser.shared.lock();
    let id = state
        .tabs
        .values()
        .find(|t| t.target == target)
        .map(|t| t.id.clone());
    if let Some(tab) = id.and_then(|id| state.remove(&id)) {
        drop(state);
        gone(browser, tab);
    }
}

/// A tab the page or the browser closed: its context may end with it.
fn gone(browser: &Arc<Browser>, tab: super::state::Tab) {
    browser.history.complete(&tab.id, &tab.url, &tab.title, "");
    browser.changed.notify_waiters();
    let browser = browser.clone();
    drop(tokio::spawn(async move {
        targets::forget(&browser, &tab).await;
    }));
}

fn crashed(browser: &Browser, target: &str) {
    let mut state = browser.shared.lock();
    if let Some(tab) = state.tabs.values_mut().find(|t| t.target == target) {
        tab.crashed = true;
    }
}

fn info_changed(browser: &Arc<Browser>, info: &Value) {
    let target = info["targetId"].as_str().unwrap_or("");
    if info["type"] == "page" {
        let session = { browser.shared.lock().others.remove(target) };
        if let Some(session) = session {
            let browser = browser.clone();
            let target = target.to_owned();
            let info = info.clone();
            drop(tokio::spawn(async move {
                targets::page_attached(browser, session, target, &info).await;
            }));
        }
    }
    let mut state = browser.shared.lock();
    if let Some(tab) = state.tabs.values_mut().find(|t| t.target == target) {
        let raw = info["url"].as_str().unwrap_or("");
        if let Ok(url) = url::Url::parse(raw)
            && matches!(url.scheme(), "http" | "https")
            && url.username().is_empty()
            && url.password().is_none()
        {
            tab.url = url.to_string();
        }
        tab.title = info["title"].as_str().unwrap_or("").to_owned();
    }
}

/// An approved upload step answers its own chooser; any other needs the owner.
fn chooser(browser: &Arc<Browser>, session: String, params: &Value) {
    let mut state = browser.shared.lock();
    let Some(id) = state.tab_of_session(&session) else {
        return;
    };
    let upload = state.tabs.get_mut(&id).and_then(|t| t.upload.take());
    let Some(upload) = upload else {
        state.event(&id, "file_chooser", &json!({"reason":"owner_required"}));
        return;
    };
    let cdp = browser.cdp.clone();
    let node = params["backendNodeId"].clone();
    drop(tokio::spawn(async move {
        let result = cdp
            .send(
                "DOM.setFileInputFiles",
                json!({"files":[upload.path],"backendNodeId":node}),
                Some(&session),
            )
            .await;
        let _ = upload.done.send(match result {
            Ok(_) => json!({"status":"completed","files":1}),
            Err(_) => json!({"status":"unknown","reason":"upload_failed"}),
        });
    }));
}

/// Chrome for Testing attaches new tabs as pages; CEF 156 first attaches them as paused "other" targets.
/// CEF then reports the page type through targetInfoChanged, without a second attachment event.
/// Resuming and detaching immediately loses the tab, so hold it briefly for page setup instead.
pub(crate) fn hold_other(
    browser: Arc<Browser>,
    parent: Option<String>,
    target: String,
    session: String,
) {
    browser.shared.lock().others.insert(target.clone(), session);
    drop(tokio::spawn(async move {
        // Its page type may have been reported while this attach was being set up: whichever of
        // this check and `info_changed` removes the entry sets the page up, exactly once.
        let info = browser
            .cdp
            .send("Target.getTargetInfo", json!({"targetId":target}), None)
            .await
            .map(|reply| reply["targetInfo"].clone())
            .unwrap_or_default();
        if info["type"] == "page" {
            let held = { browser.shared.lock().others.remove(&target) };
            if let Some(session) = held {
                targets::page_attached(browser, session, target, &info).await;
                return;
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let session = { browser.shared.lock().others.remove(&target) };
        if let Some(session) = session {
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
    }));
}
