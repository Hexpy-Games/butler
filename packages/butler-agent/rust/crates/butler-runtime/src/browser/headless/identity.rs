//! An offline probe of the engine's native platform metadata, once per launch.
use super::cdp::{Cdp, Event};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use tokio::sync::mpsc;

/// Before auto-attachment is enabled, read a throwaway secure-origin page.
/// Fetch fulfills it locally: no DNS, proxy bypass or external network access.
pub(super) async fn read(
    cdp: &Cdp,
    events: &mut mpsc::UnboundedReceiver<Event>,
) -> Result<Value, String> {
    let version = cdp.send("Browser.getVersion", json!({}), None).await?;
    let target = cdp
        .send("Target.createTarget", json!({"url":"about:blank"}), None)
        .await?;
    let target = target["targetId"].as_str().ok_or("identity_unavailable")?;
    let result = probe(cdp, events, target, &version).await;
    let _ = cdp
        .send("Target.closeTarget", json!({"targetId":target}), None)
        .await;
    result
}

async fn probe(
    cdp: &Cdp,
    events: &mut mpsc::UnboundedReceiver<Event>,
    target: &str,
    version: &Value,
) -> Result<Value, String> {
    let attached = cdp
        .send(
            "Target.attachToTarget",
            json!({"targetId":target,"flatten":true}),
            None,
        )
        .await?;
    let session = attached["sessionId"]
        .as_str()
        .ok_or("identity_unavailable")?;
    cdp.send(
        "Fetch.enable",
        json!({"patterns":[{"resourceType":"Document"}]}),
        Some(session),
    )
    .await?;
    let navigation = cdp.send(
        "Page.navigate",
        json!({"url":"http://localhost/__butler_identity__"}),
        Some(session),
    );
    let fulfill = async {
        while let Some(event) = events.recv().await {
            if event.method == "Fetch.requestPaused" && event.session.as_deref() == Some(session) {
                cdp.send(
                    "Fetch.fulfillRequest",
                    json!({"requestId":event.params["requestId"],"responseCode":200,
                    "responseHeaders":[{"name":"Content-Type","value":"text/html"}],
                    "body":STANDARD.encode("<!doctype html><title>Identity</title>")}),
                    Some(session),
                )
                .await?;
                return Ok::<(), String>(());
            }
        }
        Err("identity_unavailable".into())
    };
    tokio::try_join!(navigation, fulfill)?;
    let observed = cdp.send("Runtime.evaluate", json!({"expression":
        "navigator.userAgentData.getHighEntropyValues(['platformVersion','architecture','bitness','model','wow64'])",
        "awaitPromise":true,"returnByValue":true}), Some(session)).await?;
    normalize(version, &observed).await
}

async fn normalize(version: &Value, observed: &Value) -> Result<Value, String> {
    let native = &observed["result"]["value"];
    if !native["platform"].is_string() {
        return Err("identity_unavailable".into());
    }
    let language = tokio::task::spawn_blocking(butler_platform::instance::system_locale)
        .await
        .map_err(|_| "identity_unavailable")?
        .unwrap_or_else(|| "en-US".into());
    let full = version["product"]
        .as_str()
        .and_then(|s| s.split_once('/').map(|(_, v)| v))
        .ok_or("identity_unavailable")?;
    butler_platform::browser_process::chrome_identity(
        version["userAgent"]
            .as_str()
            .ok_or("identity_unavailable")?,
        full,
        native,
        &language,
    )
    .ok_or_else(|| "identity_unavailable".into())
}

/// Applies before running any page, OOPIF, worker or nested worker.
pub(super) async fn apply(cdp: &Cdp, session: &str, kind: &str) -> Result<(), String> {
    let identity = cdp.identity.get().ok_or("identity_unavailable")?.clone();
    let method = if kind.contains("worker") {
        cdp.send("Network.enable", json!({}), Some(session)).await?;
        "Network.setUserAgentOverride"
    } else {
        "Emulation.setUserAgentOverride"
    };
    cdp.send(method, identity, Some(session)).await?;
    cdp.send(
        "Target.setAutoAttach",
        json!({"autoAttach":true,"waitForDebuggerOnStart":true,"flatten":true}),
        Some(session),
    )
    .await?;
    Ok(())
}
