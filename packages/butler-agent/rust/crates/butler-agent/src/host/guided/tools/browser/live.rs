//! The open tab a `web_read` reads instead of fetching the page again: the
//! named `tab`, or this conversation's signed-out tab showing the URL. The
//! tab is read on every call: a click can change its page without navigating.
use super::super::GuidedTools;
use super::client::Client;
use butler_runtime::web_access::LivePage;
use butler_turn::btcc::GuidedInvocation;
use serde_json::{Value, json};

/// `Ok(None)` when no open tab shows the page (the reader fetches it);
/// `Err` is the result for a named tab that could not be read.
pub(in crate::host::guided::tools) async fn page(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    args: &Value,
) -> Result<Option<LivePage>, Value> {
    let named = args["tab"].as_str().filter(|tab| !tab.trim().is_empty());
    let url = args["url"].as_str().filter(|url| !url.trim().is_empty());
    if named.is_none() && url.is_none() {
        return Err(failure("web_read needs a url or an open tab."));
    }
    // Only a turn that may use the browser reads its tabs.
    let browsing = owner.binding.authorized_names.contains("browser_open");
    let client = if browsing {
        Client::new(owner).await
    } else {
        None
    };
    let Some(client) = client else {
        return match named {
            Some(_) => Err(failure("The browser is unavailable; read the page by url.")),
            None => Ok(None),
        };
    };
    let Some(tab) = find(owner, invocation, &client, named, url).await else {
        return match named {
            Some(_) => Err(unreadable(&json!("not_your_tab"))),
            None => Ok(None),
        };
    };
    let read = client
        .call(
            "tab.read",
            &json!(tab.id),
            &json!({}),
            invocation.cancellation,
        )
        .await;
    let html = read["html"].as_str().filter(|_| read["status"] == "ok");
    match (html, read["url"].as_str()) {
        (Some(html), Some(final_url)) => Ok(Some(LivePage {
            tab: tab.id,
            epoch: read["epoch"].as_u64().unwrap_or(tab.epoch),
            final_url: final_url.to_owned(),
            html: html.to_owned(),
        })),
        _ if named.is_some() => Err(unreadable(&read["reason"])),
        _ => Ok(None),
    }
}

struct OpenTab {
    id: String,
    epoch: u64,
    url: String,
}

/// The named tab, or this conversation's signed-out tab showing `url`.
async fn find(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    client: &Client,
    named: Option<&str>,
    url: Option<&str>,
) -> Option<OpenTab> {
    let listed = client
        .call(
            "tabs.list",
            &Value::Null,
            &json!({}),
            invocation.cancellation,
        )
        .await;
    let tabs = listed["tabs"]
        .as_array()?
        .iter()
        .filter(|tab| tab["holder"] != "user")
        .filter(|tab| named.is_some() || tab["profile"] != "signed_in")
        .filter_map(|tab| {
            Some(OpenTab {
                id: tab["id"].as_str()?.to_owned(),
                epoch: tab["epoch"].as_u64().unwrap_or(0),
                url: tab["url"].as_str()?.to_owned(),
            })
        })
        .collect::<Vec<_>>();
    let id = match named {
        Some(tab) => tab.trim().to_owned(),
        None => {
            let pairs = tabs
                .iter()
                .map(|tab| (tab.id.clone(), tab.url.clone()))
                .collect::<Vec<_>>();
            owner.web_session.open_tab_for(url?, &pairs)?
        }
    };
    tabs.into_iter().find(|tab| tab.id == id)
}

fn unreadable(reason: &Value) -> Value {
    json!({"ok":false,"error":{"code":"tab_unreadable","message":"That tab could not be read.",
        "reason":reason,
        "recovery":"Use an open tab id from browser_open or browser_tabs, or read the page by url."}})
}

fn failure(message: &str) -> Value {
    json!({"ok":false,"error":{"code":"invalid_arguments","message":message}})
}
