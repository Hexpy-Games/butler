//! Answers shared by the tab calls: lost browsers and dispatched batches.
use super::{act, browser::Browser, page};
use serde_json::{Value, json};

pub(super) fn failed(browser: &Browser, error: &str) -> Value {
    if browser.alive.is_cancelled() || error == "browser_closed" {
        return json!({"status":"unknown","reason":"browser_host_lost"});
    }
    eprintln!("WARN [browser] Background browser call failed: {error}");
    json!({"status":"unknown","reason":"executor_error"})
}

pub(super) async fn act_call(page: &page::Page, args: &Value, frame: &Value) -> Value {
    // Tabs act independently; only a second batch on a tab whose batch still
    // runs is refused.
    let claimed = page.shared.with_tab(&page.tab, |t| {
        let free = !t.busy;
        if free {
            t.busy = true;
            t.cancelled = false;
            t.call_id = frame["call_id"].as_str().map(str::to_owned);
        }
        free
    });
    if claimed == Some(false) {
        return json!({"status":"not_dispatched","reason":"browser_busy"});
    }
    let deadline = frame["deadline_ms"].as_u64().unwrap_or(30_000);
    let result = act::act(page, args, deadline).await;
    page.shared.with_tab(&page.tab, |t| t.busy = false);
    result.unwrap_or_else(|_| json!({"status":"unknown","reason":"executor_error"}))
}
