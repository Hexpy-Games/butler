//! Answers shared by the tab calls: lost browsers and dispatched batches.
use super::{act, browser::Browser, page};
use serde_json::{Value, json};

pub(super) fn failed(browser: &Browser, error: &str) -> Value {
    if browser.alive.is_cancelled() || error == "browser_closed" {
        return json!({"status":"unknown","reason":"browser_host_lost"});
    }
    eprintln!("WARN [browser] headless call failed: {error}");
    json!({"status":"unknown","reason":"executor_error"})
}

pub(super) async fn act_call(page: &page::Page, args: &Value, frame: &Value) -> Value {
    let owner = page
        .shared
        .with_tab(&page.tab, |t| t.owner.clone())
        .unwrap_or_default();
    let busy = {
        let state = page.shared.lock();
        let owners: std::collections::HashSet<&String> = state
            .tabs
            .values()
            .filter(|t| t.busy)
            .map(|t| &t.owner)
            .collect();
        (owners.len() >= 2 && !owners.contains(&owner))
            || state.tabs.get(&page.tab).is_some_and(|t| t.busy)
    };
    if busy {
        return json!({"status":"not_dispatched","reason":"browser_busy"});
    }
    page.shared.with_tab(&page.tab, |t| {
        t.busy = true;
        t.cancelled = false;
        t.call_id = frame["call_id"].as_str().map(str::to_owned);
    });
    let deadline = frame["deadline_ms"].as_u64().unwrap_or(30_000);
    let result = act::act(page, args, deadline).await;
    page.shared.with_tab(&page.tab, |t| t.busy = false);
    result.unwrap_or_else(|_| json!({"status":"unknown","reason":"executor_error"}))
}
