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
/// Only the requested tab's hand-back resumes its durable nonterminal wait. A
/// wait-for-user card names the tab; a sign-in hand-off card shows the site
/// only, so its request's stored target (the tab) is matched instead.
fn waits_on(request: &Value, tab: &Value) -> bool {
    let approval = &request["approval"];
    let names = |targets: &Value, field: Option<&str>| {
        targets
            .as_array()
            .is_some_and(|targets| targets.iter().any(|t| field.map_or(t, |f| &t[f]) == tab))
    };
    match request["executable"].as_str() {
        Some("browser_wait_for_user") => names(&approval["operation"]["targets"], None),
        Some("browser_sign_in") => {
            approval["operation"]["tool"] == "browser_sign_in_wait"
                && names(&approval["targets"], Some("path"))
        }
        _ => false,
    }
}
