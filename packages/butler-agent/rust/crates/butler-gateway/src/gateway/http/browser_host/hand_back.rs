//! A hand-back (the user gives a tab back to Butler) resumes that tab's
//! durable wait: wait-for-user and sign-in hand-off requests.
use super::{HttpError, HttpState};
use serde_json::{Value, json};

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
    is_hand_off(request)
        && request["approval"]["targets"]
            .as_array()
            .is_some_and(|targets| targets.iter().any(|t| &t["path"] == tab))
}

fn is_hand_off(request: &Value) -> bool {
    let approval = &request["approval"];
    match request["executable"].as_str() {
        Some("browser_wait_for_user") => true,
        Some("browser_sign_in") => approval["operation"]["tool"] == "browser_sign_in_wait",
        Some("browser_pay_fill" | "browser_autofill_fill") => {
            approval["operation"]["tool"] == "browser_pay_wait"
        }
        _ => false,
    }
}

/// The card's Done: hands a hand-off wait's tab back to Butler as the pane's
/// Give back does. The App flips the holder (non-sticky); its change event
/// resumes the wait through `resume_waits`. With no App holding that tab for
/// the user (no host, tab closed or already given back), the wait resumes here.
pub(in crate::gateway::http) async fn hand_back_wait(
    state: &HttpState,
    owner: String,
    request_ref: &str,
) -> Result<(), HttpError> {
    let page = state.application.authority_list(owner.clone()).await?;
    let request = page
        .requests
        .iter()
        .find(|r| r["request_ref"] == request_ref)
        .ok_or_else(|| {
            HttpError::public(404, "authority_request_not_found", "Request not found.")
        })?;
    let tab = is_hand_off(request)
        .then(|| {
            request["approval"]["targets"]
                .as_array()
                .and_then(|t| t.iter().find_map(|t| t["path"].as_str().map(str::to_owned)))
        })
        .flatten()
        .ok_or_else(|| {
            HttpError::public(
                409,
                "not_a_hand_off",
                "This request is not a browser hand-off.",
            )
        })?;
    let sent = state.browser.0.lock().is_ok_and(|hub| {
        let session = hub.tabs.get(&tab).and_then(|t| t["owner"].as_str())
            .and_then(|o| o.strip_prefix("conversation:")).map(str::to_owned);
        hub.tabs.is_user(&tab) && session.is_some_and(|session| hub.host.as_ref().is_some_and(|host|
            host.try_send(json!({"id":uuid::Uuid::new_v4().to_string(),"op":"use.given_back","session":session,"tab":tab,"args":{}})).is_ok()))
    });
    if !sent {
        state
            .application
            .authority_decide(crate::gateway::AppAuthorityDecisionInput {
                owner_session_id: owner,
                request_ref: request_ref.into(),
                action: "allow".into(),
                allow_scope: Some("once".into()),
                alternative_input: None,
            })
            .await?;
    }
    Ok(())
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

/// A user message to a conversation gives back that conversation's tabs the
/// user holds, as Give back does.
pub(in crate::gateway::http) fn give_back_on_message(state: &HttpState, session: &str) {
    if let Ok(hub) = state.browser.0.lock()
        && let Some(host) = &hub.host
        && hub
            .tabs
            .owned(session)
            .iter()
            .any(|id| hub.tabs.is_user(id))
    {
        let _ = host.try_send(json!({"id":uuid::Uuid::new_v4().to_string(),"op":"use.given_back","session":session,"args":{}}));
    }
}
