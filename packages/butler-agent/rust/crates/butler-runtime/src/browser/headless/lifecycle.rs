//! Tab creation and the idle lifecycle of the headless browser process.
use super::{Headless, browser::Browser, state, targets};
use serde_json::{Value, json};
use std::{
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};

const TAB_IDLE: Duration = Duration::from_secs(600);
const REAP_AFTER: Duration = Duration::from_secs(60);

pub(super) async fn open_tab(
    browser: &Arc<Browser>,
    owner: &str,
    url: &str,
    args: &Value,
    budget: Duration,
) -> Result<Value, String> {
    let context = targets::context(browser, owner).await?;
    let (target, session) = targets::create(&browser.cdp, &browser.shared, &context).await?;
    let id = {
        let mut state = browser.shared.lock();
        let id = state::short_id('h', |id| state.tabs.contains_key(id));
        let mut tab = state::Tab::new(
            id.clone(),
            owner.to_owned(),
            target.clone(),
            session.clone(),
        );
        tab.policy = args["policy"].clone();
        tab.context = context;
        state.tabs.insert(id.clone(), tab);
        state.sessions.insert(session.clone(), id.clone());
        id
    };
    browser.changed.notify_waiters();
    if targets::setup_page(&browser.cdp, &session).await.is_err() {
        targets::close(browser, &id).await;
        return Ok(json!({"status":"unknown","reason":"navigation_failed"}));
    }
    let Some(mut loads) = browser.shared.with_tab(&id, |t| t.loads.subscribe()) else {
        return Ok(json!({"status":"unknown","reason":"navigation_failed"}));
    };
    let navigated = browser
        .cdp
        .send("Page.navigate", json!({"url":url}), Some(&session))
        .await;
    let failed = navigated.as_ref().map_or(true, |n| {
        n["errorText"].as_str().is_some_and(|e| !e.is_empty())
    });
    if failed || browser.shared.with_tab(&id, |_| ()).is_none() {
        targets::close(browser, &id).await;
        return Ok(json!({"status":"unknown","reason":"navigation_failed"}));
    }
    let _ = tokio::time::timeout(budget, loads.changed()).await;
    let info = browser
        .cdp
        .send("Target.getTargetInfo", json!({"targetId":target}), None)
        .await
        .unwrap_or_default();
    let snapshot = browser.shared.with_tab(&id, |t| {
        if let Ok(u) = url::Url::parse(info["targetInfo"]["url"].as_str().unwrap_or(""))
            && matches!(u.scheme(), "http" | "https")
        {
            t.url = u.to_string();
        }
        if let Some(title) = info["targetInfo"]["title"].as_str() {
            t.title = title.to_owned();
        }
        t.last_call = Instant::now();
        json!({"status":"ok","tab":t.id,"url":t.url,"title":t.title,"epoch":t.epoch,"profile":"signed_out"})
    });
    Ok(snapshot.unwrap_or_else(|| json!({"status":"unknown","reason":"navigation_failed"})))
}

/// Closes idle agent tabs and ends the process tree 60 s after the last tab.
pub(super) async fn janitor(owner: std::sync::Weak<Headless>, browser: Arc<Browser>) {
    let mut empty_since: Option<Instant> = None;
    loop {
        let notified = browser.changed.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let now = Instant::now();
        let (expired, earliest, empty) = {
            let state = browser.shared.lock();
            let expired: Vec<String> = state
                .tabs
                .values()
                .filter(|t| now.duration_since(t.last_call) >= TAB_IDLE)
                .map(|t| t.id.clone())
                .collect();
            let earliest = state.tabs.values().map(|t| t.last_call + TAB_IDLE).min();
            (expired, earliest, state.tabs.is_empty())
        };
        for id in expired {
            targets::close(&browser, &id).await;
        }
        let since = if empty {
            *empty_since.get_or_insert(now)
        } else {
            empty_since = None;
            now
        };
        if empty && now.duration_since(since) >= REAP_AFTER {
            let Some(headless) = owner.upgrade() else {
                browser.stop().await;
                return;
            };
            let _start = headless.starting.lock().await;
            let idle = headless.in_flight.load(Ordering::SeqCst) == 0
                && browser.shared.lock().tabs.is_empty();
            if idle {
                headless.forget(&browser);
                browser.stop().await;
                return;
            }
            empty_since = Some(Instant::now());
            continue;
        }
        let wake = if empty {
            since + REAP_AFTER
        } else {
            earliest.unwrap_or(now + TAB_IDLE)
        };
        tokio::select! {
            () = tokio::time::sleep_until(wake.into()) => {},
            () = &mut notified => {},
            () = browser.alive.cancelled() => {
                if let Some(headless) = owner.upgrade() {
                    headless.forget(&browser);
                }
                browser.stop().await;
                return;
            },
        }
    }
}
