use super::super::{authority::request_action, listeners::TunnelPeer};
use super::hand_back::{hand_back_wait, hand_off_tab, tab_session};
use super::{
    Body, Client, HttpError, HttpState, Method, PendingCall, Request, Response, error, fill,
};
use butler_platform::secrets::SecretText;
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

type Result<T> = std::result::Result<T, HttpError>;

const KINDS: [&str; 3] = ["username", "password", "otp"];
pub(super) const TTL: Duration = Duration::from_secs(10);

pub(super) struct InputFill {
    pub(super) values: Vec<(&'static str, SecretText)>,
    pub(super) origin: String,
    pub(super) expires: Instant,
}

pub fn secure_channel(request: &Request<Body>, client: &Client) -> Result<()> {
    if request.method() == Method::POST
        && !client.local
        && request.extensions().get::<TunnelPeer>().is_none()
        && matches!(request_action(request.uri().path()), Some((_, "input")))
    {
        return Err(error(403, "secure_channel_required"));
    }
    Ok(())
}

async fn ask_host(
    state: &Arc<HttpState>,
    tab: &str,
    op: &str,
    args: Value,
    deadline: u64,
) -> Value {
    let id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    let sent = state.browser.0.lock().is_ok_and(|mut hub| {
        let Some((host, session)) = hub.host.as_ref().zip(tab_session(&hub, tab)) else {
            return false;
        };
        let frame = json!({"id":id,"op":op,"session":session,"tab":tab,"args":args,"deadline_ms":deadline * 1000});
        if host.try_send(frame).is_err() {
            return false;
        }
        hub.pending.insert(id.clone(), sender.into());
        true
    });
    if !sent {
        return json!({"status":"unavailable","reason":"no_browser"});
    }
    let _pending = PendingCall {
        state: state.clone(),
        id,
    };
    match tokio::time::timeout(Duration::from_secs(deadline), receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => json!({"status":"unknown","reason":"browser_host_lost"}),
        Err(_) => json!({"status":"unknown","reason":"timeout"}),
    }
}

pub async fn fields(state: &Arc<HttpState>, owner: String, reference: &str) -> Result<Value> {
    let tab = hand_off_tab(state, owner, reference).await?;
    if state
        .browser
        .0
        .lock()
        .map_err(|_| HttpError::Internal)?
        .input_busy
        .contains(reference)
    {
        return Err(error(409, "input_busy"));
    }
    Ok(shaped(
        &ask_host(state, &tab, "input.fields", json!({}), 5).await,
    ))
}

pub async fn fill(
    state: &Arc<HttpState>,
    owner: String,
    reference: &str,
    mut body: Value,
) -> Result<Value> {
    let mut values = Vec::new();
    for kind in KINDS {
        if let Some(Value::String(text)) = body
            .get_mut("values")
            .and_then(|values| values.get_mut(kind))
        {
            let text = SecretText::new(std::mem::take(text));
            if text.expose().chars().take(1025).count() > 1024 {
                return Err(error(400, "input_too_long"));
            }
            if !text.expose().is_empty() {
                values.push((kind, text));
            }
        }
    }
    if values.is_empty() {
        return Err(error(400, "input_required"));
    }
    let tab = hand_off_tab(state, owner.clone(), reference).await?;
    let guard = fill::InputToken::mint(state, reference, &tab, &body["origin"], values)?;
    let call = ask_host(state, &tab, "input.fill", json!({"token":guard.token}), 20);
    tokio::pin!(call);
    let result = tokio::time::timeout(TTL, &mut call).await;
    guard.remove_token();
    let mut result = shaped(&match result {
        Ok(result) => result,
        Err(_) => call.await,
    });
    let hand_back = result["status"] == "filled"
        && result["navigated"] == true
        && result["fields"] == json!([])
        && result["live"] == false
        && result["save_offer"].is_null();
    if hand_back {
        hand_back_wait(state, owner, reference).await?;
    }
    result["handed_back"] = json!(hand_back);
    Ok(result)
}

pub async fn save(
    state: &Arc<HttpState>,
    owner: String,
    reference: &str,
    body: &Value,
) -> Result<Value> {
    let tab = hand_off_tab(state, owner.clone(), reference).await?;
    let result = ask_host(
        state,
        &tab,
        "signin.save_offer",
        json!({"save":body["save"] == true}),
        10,
    )
    .await;
    let fields = fields(state, owner.clone(), reference).await?;
    let hand_back = fields["fields"] == json!([]) && fields["live"] == false;
    if hand_back {
        hand_back_wait(state, owner, reference).await?;
    }
    Ok(
        json!({"saved":result["ok"] == true,"error":result["error"]["code"].as_str(),"handed_back":hand_back}),
    )
}

pub(super) async fn pull(state: Arc<HttpState>, token: &str, body: &Value) -> Result<Response> {
    let fill = state
        .browser
        .0
        .lock()
        .map_err(|_| HttpError::Internal)?
        .inputs
        .remove(token);
    let Some(fill) = fill.filter(|fill| fill.expires > Instant::now()) else {
        return Err(error(410, "input_token_expired"));
    };
    if body["origin"] != fill.origin.as_str() {
        return Err(error(403, "origin_mismatch"));
    }
    fill::secret_response(
        fill.values
            .iter()
            .map(|(kind, value)| (*kind, value.expose())),
    )
}

fn shaped(result: &Value) -> Value {
    let status = match result["status"].as_str() {
        Some(
            s @ ("filled" | "no_fields" | "origin_mismatch" | "input_unavailable" | "unavailable"),
        ) => s,
        _ => "unknown",
    };
    let fields: Vec<_> = result["fields"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|kind| KINDS.contains(kind))
        .collect();
    let offer = &result["save_offer"];
    let offer = offer["username"]
        .as_str()
        .zip(offer["host"].as_str())
        .map(|(username, host)| json!({"username":username,"host":host}));
    json!({"status":status,"fields":fields,"live":result["live"] == true,"navigated":result["navigated"] == true,
        "origin":result["origin"].as_str().unwrap_or(""),"save_offer":offer})
}
