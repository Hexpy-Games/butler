use super::super::GuidedTools;
use serde_json::Value;

/// An opened page is remembered so `web_read` reads its tab.
pub(super) fn remember(owner: &GuidedTools, args: &Value, result: &Value) {
    if result["status"] == "ok"
        && let (Some(url), Some(tab)) = (args["url"].as_str(), result["tab"].as_str())
    {
        let landed = result["url"].as_str().unwrap_or(url);
        owner.web_session.remember_tab(url, tab, landed);
        // The page was requested already; reading it again sends nothing new.
        owner.web_session.discover(url);
        owner.web_session.discover(landed);
    }
}
