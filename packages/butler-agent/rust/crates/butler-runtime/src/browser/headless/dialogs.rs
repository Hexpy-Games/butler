//! JavaScript dialogs of headless tabs (the App executor's `dialogs.mjs`):
//! intercepted as events, alerts may be dismissed, every other answer comes
//! from the owner. A hidden tab never hangs on a dialog: it times out.
use super::{
    browser::Browser,
    capture,
    page::Page,
    state::{Dialog, short_id},
    targets,
};
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const DIALOG_TIMEOUT: Duration = Duration::from_secs(120);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

pub(crate) fn opening(browser: &Arc<Browser>, session: &str, params: &Value) {
    let mut state = browser.shared.lock();
    let Some(id) = state.tab_of_session(session) else {
        return;
    };
    let Some(tab) = state.tabs.get_mut(&id) else {
        return;
    };
    if tab.dialog.is_some() {
        return;
    }
    let kind = params["type"].as_str().unwrap_or("alert").to_owned();
    let dialog_id = short_id('d', |_| false);
    tab.dialog = Some(Dialog {
        id: dialog_id.clone(),
        epoch: tab.epoch,
        before_unload_close: kind == "beforeunload" && tab.closing,
        kind,
        message: params["message"].as_str().unwrap_or("").to_owned(),
        default_prompt: params["defaultPrompt"].as_str().unwrap_or("").to_owned(),
        origin: params["url"]
            .as_str()
            .map_or_else(|| tab.url.clone(), str::to_owned),
        deadline_ms: now_ms() + u64::try_from(DIALOG_TIMEOUT.as_millis()).unwrap_or(0),
        session: session.to_owned(),
        answering: false,
    });
    tab.waiting = true;
    tab.dialogs.send_modify(|n| *n += 1);
    let public = tab.public_dialog();
    state.event(&id, "dialog_opened", &json!({"dialog":public}));
    let browser = browser.clone();
    drop(tokio::spawn(async move {
        tokio::time::sleep(DIALOG_TIMEOUT).await;
        resolve(&browser, &id, &dialog_id, false, "", "timeout").await;
    }));
}

pub(crate) fn closed(browser: &Browser, session: &str) {
    let mut state = browser.shared.lock();
    let Some(id) = state.tab_of_session(session) else {
        return;
    };
    let Some(tab) = state.tabs.get_mut(&id) else {
        return;
    };
    let Some(dialog) = tab
        .dialog
        .as_ref()
        .filter(|d| !d.answering && !d.before_unload_close)
    else {
        return;
    };
    let data = json!({"dialog":dialog.id,"dialog_type":dialog.kind,"reason":"page_closed"});
    tab.dialog = None;
    tab.waiting = false;
    state.event(&id, "dialog_cancelled", &data);
}

/// Answers the tab's open dialog `dialog_id` (accept or cancel).
pub(crate) async fn resolve(
    browser: &Browser,
    tab: &str,
    dialog_id: &str,
    accept: bool,
    text: &str,
    reason: &str,
) {
    let target = browser
        .shared
        .with_tab(tab, |t| {
            let dialog = t
                .dialog
                .as_mut()
                .filter(|d| d.id == dialog_id && !d.answering)?;
            dialog.answering = true;
            Some((dialog.session.clone(), dialog.kind.clone()))
        })
        .flatten();
    let Some((session, kind)) = target else {
        return;
    };
    let _ = browser
        .cdp
        .send(
            "Page.handleJavaScriptDialog",
            json!({"accept":accept,"promptText":text}),
            Some(&session),
        )
        .await;
    let mut state = browser.shared.lock();
    if let Some(entry) = state.tabs.get_mut(tab) {
        if entry.dialog.as_ref().is_some_and(|d| d.id == dialog_id) {
            entry.dialog = None;
        }
        entry.waiting = false;
    }
    let event = if accept {
        "dialog_accepted"
    } else {
        "dialog_cancelled"
    };
    state.event(
        tab,
        event,
        &json!({"dialog":dialog_id,"dialog_type":kind,"reason":reason}),
    );
}

/// `tab.dialog`: the owner's answer; the interrupted batch's receipts complete.
pub(crate) async fn answer(browser: &Browser, page: &Page, args: &Value) -> Value {
    let current = page
        .shared
        .with_tab(&page.tab, |t| {
            t.dialog
                .as_ref()
                .filter(|d| args["dialog"] == d.id.as_str() && d.epoch == t.epoch)
                .map(|d| (d.id.clone(), d.before_unload_close))
        })
        .flatten();
    let Some((id, close)) = current else {
        return json!({"status":"not_dispatched","reason":"stale_dialog"});
    };
    let accept = args["accept"] == true;
    resolve(
        browser,
        &page.tab,
        &id,
        accept,
        args["value"].as_str().unwrap_or(""),
        "answered",
    )
    .await;
    if close && accept {
        targets::close(browser, &page.tab).await;
        return json!({"status":"ok","tab":page.tab});
    }
    let pending = page
        .shared
        .with_tab(&page.tab, |t| t.pending_batch.take())
        .flatten()
        .unwrap_or_default();
    let mut steps: Vec<Value> = pending
        .into_iter()
        .map(|mut step| {
            if step["reason"] == "dialog_pending" {
                step["status"] = json!("completed");
                if let Some(map) = step.as_object_mut() {
                    map.remove("reason");
                }
            }
            step
        })
        .collect();
    if let Some(last) = steps.iter_mut().rev().find(|s| s["status"] == "completed")
        && let Some(still) = capture::still(page).await
    {
        last["still"] = still;
    }
    let (epoch, url) = page
        .shared
        .with_tab(&page.tab, |t| (t.epoch, t.url.clone()))
        .unwrap_or_default();
    json!({"status":"ok","tab":page.tab,"epoch":epoch,"url":url,"steps":steps})
}

/// `tab.close`: runs the page's beforeunload, which may need the owner.
pub(crate) async fn request_close(browser: &Browser, page: &Page) -> Value {
    let pending = page
        .shared
        .with_tab(&page.tab, |t| {
            t.dialog.is_some().then(|| t.pending_dialog())
        })
        .flatten();
    if let Some(pending) = pending {
        return pending;
    }
    let crashed = page.shared.with_tab(&page.tab, |t| {
        t.closing = true;
        t.crashed
    });
    if crashed != Some(false) {
        targets::close(browser, &page.tab).await;
        return json!({"status":"ok"});
    }
    let Some(mut dialogs) = page.shared.with_tab(&page.tab, |t| t.dialogs.subscribe()) else {
        return json!({"status":"ok"});
    };
    let _ = page.send("Page.close", json!({})).await;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(4500);
    loop {
        if page.shared.with_tab(&page.tab, |_| ()).is_none() {
            browser.changed.notify_waiters();
            return json!({"status":"ok","tab":page.tab});
        }
        if let Some(pending) = page
            .shared
            .with_tab(&page.tab, |t| {
                t.dialog.is_some().then(|| t.pending_dialog())
            })
            .flatten()
        {
            page.shared.with_tab(&page.tab, |t| t.closing = false);
            return pending;
        }
        tokio::select! {
            _ = dialogs.changed() => {},
            () = tokio::time::sleep(Duration::from_millis(50)) => {},
        }
        if tokio::time::Instant::now() >= deadline {
            page.shared.with_tab(&page.tab, |t| t.closing = false);
            return json!({"status":"unknown","reason":"close_interrupted"});
        }
    }
}
