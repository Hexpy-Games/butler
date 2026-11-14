use super::super::state::short_id;
use super::{Browser, Tab, close, make_room, setup_page, web_url};
use serde_json::{Value, json};
use std::sync::Arc;

pub(crate) async fn page_attached(
    browser: Arc<Browser>,
    session: String,
    target: String,
    info: &Value,
) {
    let opener = info["openerId"].as_str().and_then(|opener| {
        let state = browser.shared.lock();
        state.tabs.values().find(|t| t.target == opener).map(|t| {
            (
                t.id.clone(),
                t.owner.clone(),
                t.url.clone(),
                t.policy.clone(),
                (t.context.clone(), t.preview.clone()),
            )
        })
    });
    let Some((opener, owner, parent_url, policy, (context, preview))) = opener else {
        claim_or_close(&browser, target, session).await;
        return;
    };
    let url = info["url"].as_str().unwrap_or("").to_owned();
    let turn = browser
        .shared
        .with_tab(&opener, |t| t.turn.clone())
        .flatten();
    let room = make_room(&browser, &[&opener], turn.as_deref()).await;
    let admitted = {
        let mut state = browser.shared.lock();
        if room {
            let id = short_id('h', |id| state.tabs.contains_key(id));
            let mut tab = Tab::new(id.clone(), owner, target.clone(), session.clone());
            tab.turn = turn;
            tab.opener = Some(opener.clone());
            tab.popup_parent_url = Some(parent_url);
            tab.policy = policy;
            tab.context = context;
            tab.preview = preview;
            tab.url = web_url(&url).map(|u| u.to_string()).unwrap_or_default();
            state.tabs.insert(id.clone(), tab);
            state.sessions.insert(session.clone(), id.clone());
            state.event(&opener, "popup_opened", &json!({"popup":id,"url":url}));
            Some(id)
        } else {
            let site = web_url(&parent_url)
                .map(|u| u.origin().ascii_serialization())
                .unwrap_or_default();
            state.event(
                &opener,
                "popup_blocked",
                &json!({"url":url,"site":site,"reason":"tab_budget_exhausted"}),
            );
            None
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

/// No opener: a page this process is creating waits for its claim; any other page is closed.
async fn claim_or_close(browser: &Browser, target: String, session: String) {
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
}
