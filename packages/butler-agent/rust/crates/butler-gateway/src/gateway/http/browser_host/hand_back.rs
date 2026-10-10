//! A hand-back (the user gives a tab back to Butler) resumes that tab's
//! durable wait: wait-for-user and sign-in hand-off requests.
use super::{HttpError, HttpState};
use serde_json::Value;

pub(super) async fn resume_waits(state: &HttpState, tabs: &[Value]) -> Result<(), HttpError> {
    for tab in tabs {
        let Some(session) = tab["owner"]
            .as_str()
            .and_then(|s| s.strip_prefix("conversation:"))
        else {
            continue;
        };
        let owner = crate::gateway::application::app_session_hint(session);
        let requests = state.application.authority_list(owner.clone()).await?;
        for request in &requests.requests {
            if waits_on(request, &tab["id"]) {
                state
                    .application
                    .authority_decide(crate::gateway::AppAuthorityDecisionInput {
                        owner_session_id: owner.clone(),
                        request_ref: request["request_ref"].as_str().unwrap_or("").into(),
                        action: "allow".into(),
                        allow_scope: Some("once".into()),
                        alternative_input: None,
                    })
                    .await?;
            }
        }
    }
    Ok(())
}
/// Only the requested tab's hand-back resumes its durable nonterminal wait.
/// The hand-off cards show the site, never the tab id, so the request's
/// stored target (the tab) is matched.
fn waits_on(request: &Value, tab: &Value) -> bool {
    let approval = &request["approval"];
    let hand_off = match request["executable"].as_str() {
        Some("browser_wait_for_user") => true,
        Some("browser_sign_in") => approval["operation"]["tool"] == "browser_sign_in_wait",
        _ => false,
    };
    hand_off
        && approval["targets"]
            .as_array()
            .is_some_and(|targets| targets.iter().any(|t| &t["path"] == tab))
}
/// The site of a tab for the wait card, which never shows the tab id ("" when unknown).
pub(super) fn tab_site(state: &HttpState, tab: &Value) -> String {
    let url = state.browser.0.lock().ok().and_then(|hub| {
        hub.tabs
            .get(tab.as_str().unwrap_or(""))
            .and_then(|tab| tab["url"].as_str().map(str::to_owned))
    });
    url.and_then(|url| butler_runtime::browser::site_of(&url))
        .unwrap_or_default()
}
