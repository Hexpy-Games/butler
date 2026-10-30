//! `browser_devtools {tab, read}`: console errors, a network summary or the
//! DOM of a tab, read-only. Where the tab stands now decides whether to ask:
//! Butler's pages and local dev servers never, a site without a sign-in once
//! per site, a signed-in tab every time. The read then runs only against that
//! same standing; a tab that moved meanwhile returns nothing.
use super::super::{GuidedTools, dispatch::encoded};
use super::{authority, client, encode_page_data, grant, settle};
use butler_core::json::JsonDocument;
use butler_runtime::browser::{
    DEVTOOLS_PLACE_OP, DEVTOOLS_READ_OP, DevtoolsPlace as Place, devtools_scope,
};
use butler_turn::btcc::{AccessMode, GuidedInvocation, ModelRoundToolCall, ToolExecutionError};
use serde_json::{Value, json};

const READS: &[&str] = &["console", "network", "dom"];
const MAX_SELECTOR: usize = 200;

fn place_of(reply: &Value) -> Option<Place> {
    match reply["place"].as_str() {
        Some("local") => Some(Place::Local),
        Some("local_moved") => Some(Place::LocalMoved),
        Some("signed_out") => Some(Place::SignedOut),
        Some("signed_in") => Some(Place::SignedIn),
        _ => None,
    }
}

/// Signed-in reads and a loopback page a page moved the tab to ask on every
/// tier; a signed-out site follows the tier, and full access means it does not ask.
fn asks(mode: &AccessMode, place: Place) -> bool {
    match place {
        Place::Local => false,
        Place::SignedOut => *mode != AccessMode::FullAccess,
        Place::SignedIn | Place::LocalMoved => true,
    }
}

/// The exact action a card shows and a resumed call must match.
fn card_input(args: &Value, read: &str, standing: &Value, place: Place) -> Value {
    let selector = args["selector"].as_str().filter(|_| read == "dom");
    let mut input = json!({"devtools":{"read":read,"site":standing["site"],"host":standing["host"],"selector":selector},
        "tab":args["tab"],"mode":standing["mode"]});
    if matches!(place, Place::SignedIn | Place::LocalMoved) {
        input["always_confirm"] = json!(true);
    }
    input
}

/// What the host reads. Built here so a model argument cannot set the standing.
fn read_args(args: &Value, read: &str, standing: &Value) -> Value {
    json!({"read":read,"selector":args["selector"],"only_failed":args["only_failed"],"offset":args["offset"],
        "expect":{"place":standing["place"],"site":standing["site"]}})
}

fn invalid(args: &Value) -> Option<&'static str> {
    let read = args["read"].as_str()?;
    if !READS.contains(&read) {
        return Some("invalid_read");
    }
    args["selector"]
        .as_str()
        .is_some_and(|selector| selector.len() > MAX_SELECTOR)
        .then_some("invalid_selector")
}

pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
    client: client::Client,
    args: Value,
) -> Result<JsonDocument, ToolExecutionError> {
    let Some(read) = args["read"].as_str() else {
        return encoded(&json!({"status":"not_dispatched","reason":"invalid_read"}));
    };
    if let Some(reason) = invalid(&args) {
        return encoded(&json!({"status":"not_dispatched","reason":reason}));
    }
    let signal = invocation.cancellation;
    let tab = &args["tab"];
    // The browser checks a selector before anyone is asked about it.
    let check = json!({"selector":args["selector"].as_str().filter(|_| read == "dom")});
    let request = (DEVTOOLS_PLACE_OP, tab, &check);
    let standing = grant::call(owner, call, occurrence, &client, request, signal).await?;
    let Some(place) = place_of(&standing).filter(|_| standing["status"] == "ok") else {
        if standing["authority_pending"] != true {
            authority::refuse_resume(owner, call, occurrence).await?;
        }
        return encode_page_data(standing);
    };
    let mut approval = None;
    if asks(&owner.binding.access_mode, place) {
        if client.approval_handoff {
            return encoded(&super::handoff(&args, "devtools_approval_required"));
        }
        let input = card_input(&args, read, &standing, place);
        let site = standing["site"].as_str().unwrap_or("");
        match authority::gate(
            owner,
            call,
            occurrence,
            &input,
            &devtools_scope(place, site),
        )
        .await?
        {
            authority::Gate::Pending(pending) => return encoded(&pending),
            authority::Gate::Allowed(reference, _) => approval = reference,
        }
    } else {
        // Allowed for a page that became one needing no card: nothing to apply it to.
        authority::refuse_resume(owner, call, occurrence).await?;
    }
    let args = read_args(&args, read, &standing);
    let result = client.call(DEVTOOLS_READ_OP, tab, &args, signal).await;
    let status = if result["status"] == "ok" {
        "ok"
    } else {
        "failed"
    };
    settle(owner, approval, status).await?;
    encode_page_data(result)
}
