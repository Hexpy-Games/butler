//! Signed-in tabs: every call re-reads the conversation's live site grants,
//! sends the resulting policy for main to enforce, and re-checks what main
//! reports. A tab the user drags in from their own tabs grants its site.
use super::{HttpError, HttpState, error};
use crate::gateway::AppSignInCommand;
use butler_runtime::browser::{
    SignedInPlace, frames_consistent, signed_in_place, signed_in_policy, site_of, site_of_host,
};
use serde_json::{Value, json};
use std::sync::Arc;

/// Ops that need no site grant: waits, cancels and the user's own picks.
const UNGATED: &[&str] = &["tab.wait", "tab.waiting", "tab.cancel", "tab.selection"];
/// Ops that only read the page; allowed on an identity page on the way back.
const READS: &[&str] = &["tab.observe", "tab.zoom", "tab.screenshot"];

/// The signed-in sites a conversation's turn may use.
pub(super) async fn granted_sites(
    state: &Arc<HttpState>,
    session: &str,
    turn: Option<&str>,
) -> Result<Vec<String>, HttpError> {
    let value = state
        .application
        .signins(AppSignInCommand::Grants {
            session: session.into(),
            turn: turn.map(str::to_owned),
        })
        .await?;
    Ok(serde_json::from_value(value["sites"].clone()).unwrap_or_default())
}

pub(super) fn content_origin(state: &HttpState) -> String {
    format!("http://127.0.0.1:{}", super::super::content::port(state))
}

fn grant_required(site: &str) -> Value {
    json!({"status":"not_dispatched","reason":"signed_in_grant_required","site":site,
        "recovery":"The user must allow this site's signed-in use in this conversation; the call asks them."})
}

/// Applies the signed-in fence before dispatch. `Some` is the refusal to answer.
pub(super) async fn admit(
    state: &Arc<HttpState>,
    frame: &mut Value,
    op: &str,
    session: &str,
) -> Result<Option<Value>, HttpError> {
    let turn = frame["turn_id"].as_str().map(str::to_owned);
    if op == "tab.open" {
        if frame["args"]["signed_in"] != true {
            return Ok(None);
        }
        let url = frame["args"]["url"].as_str().unwrap_or("").to_owned();
        let site = site_of(&url).ok_or_else(|| error(400, "navigation_denied"))?;
        let sites = granted_sites(state, session, turn.as_deref()).await?;
        if signed_in_place(&url, &sites) != SignedInPlace::Granted {
            return Ok(Some(grant_required(&site)));
        }
        frame["args"]["profile"] = json!("signed_in");
        frame["args"]["policy"] = signed_in_policy(&content_origin(state), &sites);
        return Ok(None);
    }
    let tab = {
        let hub = state.browser.0.lock().map_err(|_| HttpError::Internal)?;
        hub.tabs.get(frame["tab"].as_str().unwrap_or("")).cloned()
    };
    let Some(tab) = tab.filter(|tab| tab["profile"] == "signed_in") else {
        return Ok(None);
    };
    if UNGATED.contains(&op) || tab["owner"] != format!("conversation:{session}") {
        return Ok(None);
    }
    let url = tab["url"].as_str().unwrap_or("");
    let sites = granted_sites(state, session, turn.as_deref()).await?;
    let place = signed_in_place(url, &sites);
    let refused = match place {
        SignedInPlace::Granted => false,
        SignedInPlace::Identity => !READS.contains(&op),
        SignedInPlace::Denied => true,
    };
    if refused {
        return Ok(Some(match site_of(url) {
            Some(site) if butler_runtime::browser::public_url(url).is_ok() => grant_required(&site),
            _ => json!({"status":"not_dispatched","reason":"navigation_denied"}),
        }));
    }
    frame["args"]["policy"] = signed_in_policy(&content_origin(state), &sites);
    Ok(None)
}

/// Turns a result that fails the signed-in re-check into a policy violation.
pub(super) fn recheck(frame: &Value, result: &mut Value) {
    if !result_permitted(frame, result) {
        result["url"] = json!("about:blank#policy");
    }
}

/// Rust's re-check of a signed-in result: the page and every frame class.
pub(super) fn result_permitted(frame: &Value, result: &Value) -> bool {
    let policy = &frame["args"]["policy"];
    if policy["mode"] != "signed_in" {
        return true;
    }
    let sites: Vec<String> = serde_json::from_value(policy["sites"].clone()).unwrap_or_default();
    let Some(url) = result["url"].as_str() else {
        return true;
    };
    if signed_in_place(url, &sites) == SignedInPlace::Denied {
        return false;
    }
    let top = site_of(url).unwrap_or_default();
    result["frames"]
        .as_array()
        .is_none_or(|frames| frames_consistent(frames, &top, &sites))
}

/// Records a conversation site grant the user approved on a card (`signin.grant`).
pub(super) async fn grant(
    state: &Arc<HttpState>,
    session: &str,
    args: &Value,
) -> Result<Value, HttpError> {
    let site = args["site"].as_str().unwrap_or("");
    if !site_of_host(site).is_some_and(|registrable| registrable == site && site.contains('.')) {
        return Err(error(400, "invalid_site"));
    }
    state
        .application
        .signins(AppSignInCommand::Grant {
            session: session.into(),
            site: site.into(),
            source: "approval".into(),
        })
        .await?;
    Ok(json!({"status":"ok","site":site}))
}

/// Grants the site of every signed-in tab the user dragged from their own tabs
/// into a conversation (spec Q3). Page content cannot cause a move.
pub(super) async fn record_handovers(
    state: &Arc<HttpState>,
    handovers: Vec<(String, String)>,
) -> Result<(), HttpError> {
    for (session, url) in handovers {
        if butler_runtime::browser::public_url(&url).is_err() {
            continue;
        }
        let Some(site) = site_of(&url) else { continue };
        state
            .application
            .signins(AppSignInCommand::Grant {
                session,
                site,
                source: "handover".into(),
            })
            .await?;
    }
    Ok(())
}

/// Fences live signed-in conversation tabs on a site whose access was revoked.
pub(in crate::gateway::http) fn fence_site(state: &HttpState, site: &str) {
    if let Ok(hub) = state.browser.0.lock()
        && let Some(host) = &hub.host
    {
        let _ = host.try_send(json!({"id":uuid::Uuid::new_v4().to_string(),"op":"use.signin_revoked","args":{"site":site}}));
    }
}
