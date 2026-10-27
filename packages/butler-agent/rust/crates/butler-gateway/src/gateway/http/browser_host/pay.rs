//! Payment and autofill fills: Rust checks the tab, the saved item and the
//! origins main inspected, mints a single-use 10 s token bound to the exact
//! top-level origin and payment frame origins, and sends only the token.
//! Main pulls the values once over the authenticated vault route and types
//! them. Values never ride the host stream or enter a result, event or audit.
use super::super::security_settings::vault::{self, secret::VaultSecret};
use super::super::signin_secrets;
use super::{HttpError, HttpState, error};
use crate::gateway::AppVaultCommand;
use axum::{
    body::Body,
    http::{HeaderValue, StatusCode, header},
    response::Response,
};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::{Duration, Instant};

const TOKEN_TTL: Duration = Duration::from_secs(10);
const RESULTS: &[&str] = &["filled", "no_fields", "origin_mismatch", "user_required"];
const HUMAN_STEPS: &[&str] = &[
    "secure_keypad",
    "app_auth",
    "otp",
    "three_ds",
    "captcha",
    "unknown_form",
];
/// What a fill may report it typed or still lacks (field kinds, never values).
const FIELD_KINDS: &[&str] = &[
    "number",
    "expiry",
    "exp_month",
    "exp_year",
    "cvc",
    "name",
    "pin2",
    "owner_id",
    "family_name",
    "name_latin",
    "name_latin_surname",
    "name_latin_given",
    "organization",
    "country",
    "postal_code",
    "region",
    "city",
    "address_line1",
    "address_line2",
    "issuing_country",
    "full_name",
    "surname",
    "given_name",
    "birth_date",
    "gender",
    "nationality",
    "passport_number",
    "passport_expiry",
    "rrn",
    "phone",
    "email",
];

pub(super) struct VaultFill {
    kind: &'static str,
    item: String,
    top: String,
    frames: Vec<String>,
    expires: Instant,
}

fn refused(reason: &str, recovery: &str) -> Value {
    json!({"status":"not_dispatched","reason":reason,"recovery":recovery})
}

fn origin_of(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.origin().ascii_serialization())
}

/// The merchant's site: the tab's own, or its opener's for a pop-up payment window.
pub(super) fn merchant_site(state: &HttpState, tab: &Value) -> String {
    let opener = tab["opener"].as_str().and_then(|id| {
        let hub = state.browser.0.lock().ok()?;
        hub.tabs
            .get(id)
            .and_then(|t| t["url"].as_str().map(str::to_owned))
    });
    let url = opener
        .as_deref()
        .or_else(|| tab["url"].as_str())
        .unwrap_or("");
    butler_runtime::browser::site_of(url).unwrap_or_default()
}

/// Whether the user lets purchases on the tab's merchant site skip the final card.
pub(super) async fn purchase_allowed(
    state: &Arc<HttpState>,
    tab: &Value,
) -> Result<bool, HttpError> {
    let site = merchant_site(state, tab);
    if site.is_empty() {
        return Ok(false);
    }
    let value = state
        .application
        .vault(AppVaultCommand::PurchaseAllowed { site })
        .await?;
    Ok(value["allowed"] == true)
}

/// `pay.lookup`: what the model may see for the tab's merchant site.
pub(super) async fn lookup(state: &Arc<HttpState>, tab: &Value) -> Result<Value, HttpError> {
    if !signin_secrets::available(state).await {
        return Ok(refused(
            "vault_unavailable",
            "Saved payment methods are off on this computer. Ask the user to enter the details in the tab, then call browser_wait_for_user with reason secure_field.",
        ));
    }
    let site = merchant_site(state, tab);
    let list = state
        .application
        .vault(AppVaultCommand::ForSite { site: site.clone() })
        .await?;
    Ok(
        json!({"status":"ok","site":site,"cards":list["cards"],"profiles":list["profiles"],"purchase_allowed":purchase_allowed(state, tab).await?}),
    )
}

fn expired(card: &Value) -> bool {
    use chrono::Datelike;
    let today = chrono::Utc::now();
    let now = (i64::from(today.year()), i64::from(today.month()));
    (
        card["exp_year"].as_i64().unwrap_or(0),
        card["exp_month"].as_i64().unwrap_or(0),
    ) < now
}

/// What main may know about the item to fill it: never a secret.
fn meta(kind: &str, item: &Value) -> Value {
    if kind == "card" {
        json!({"exp_month": item["exp_month"], "exp_year": item["exp_year"], "holder_name": item["holder_name"],
            "brand": item["brand"], "billing": item["billing"], "extras": item["extras"]})
    } else {
        json!({"details": item["details"], "extras": item["extras"]})
    }
}

/// Prepares a `pay.fill` / `autofill.fill` frame: re-checks the item and the
/// tab's origin, then mints the token. `Some` is the refusal to answer.
pub(super) async fn prepare(
    state: &Arc<HttpState>,
    frame: &mut Value,
    tab: &Value,
) -> Result<Option<Value>, HttpError> {
    if frame["op"] == "pay.fill" && frame["schedule_browser"]["payment"] == false {
        return Ok(Some(
            json!({"status":"not_dispatched","reason":"schedule_payment_off"}),
        ));
    }
    let kind = if frame["op"] == "pay.fill" {
        "card"
    } else {
        "profile"
    };
    if !signin_secrets::available(state).await {
        return Ok(Some(refused(
            "vault_unavailable",
            "Saved payment methods are off on this computer.",
        )));
    }
    let args = frame["args"].clone();
    let id = args["item_id"].as_str().unwrap_or("").to_owned();
    let Some(item) = vault::item_meta(state, kind, &id).await? else {
        return Ok(Some(refused(
            "vault_item_missing",
            "The saved item is gone; look up the saved items again.",
        )));
    };
    if kind == "card" && expired(&item) {
        return Ok(Some(refused(
            "card_expired",
            "The saved card has expired. Ask the user to update it in Settings.",
        )));
    }
    let top = args["top_origin"].as_str().unwrap_or("").to_owned();
    if origin_of(tab["url"].as_str().unwrap_or("")).as_deref() != Some(top.as_str()) {
        return Ok(Some(json!({"status":"origin_mismatch","tab":frame["tab"]})));
    }
    if let Some(refused) = super::payment_scope::prepare(state, frame, tab).await? {
        return Ok(Some(refused));
    }
    let frames: Vec<String> = args["frame_origins"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(origin_of)
        .take(8)
        .collect();
    let token = uuid::Uuid::new_v4().simple().to_string();
    {
        let mut hub = state.browser.0.lock().map_err(|_| HttpError::Internal)?;
        let now = Instant::now();
        hub.vault_fills.retain(|_, fill| fill.expires > now);
        hub.vault_fills.insert(
            token.clone(),
            VaultFill {
                kind,
                item: id.clone(),
                top: top.clone(),
                frames: frames.clone(),
                expires: now + TOKEN_TTL,
            },
        );
    }
    frame["args"] = json!({
        "kind": kind, "item_id": id, "fill_token": token, "top_origin": top, "frame_origins": frames,
        "payment_skip": frame["args"]["payment_skip"], "meta": meta(kind, &item), "targets": args["targets"], "section_ref": args["section_ref"], "policy": args["policy"],
    });
    Ok(None)
}

fn kinds(result: &Value, key: &str) -> Vec<String> {
    result[key]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|kind| FIELD_KINDS.contains(kind))
        .map(str::to_owned)
        .collect()
}

/// Shapes main's fill result to the closed vocabulary and writes the audit row.
pub(super) async fn finish(
    state: &Arc<HttpState>,
    sent: &Value,
    session: &str,
    result: &Value,
) -> Result<Value, HttpError> {
    if let Ok(mut hub) = state.browser.0.lock()
        && let Some(token) = sent["args"]["fill_token"].as_str()
    {
        hub.vault_fills.remove(token);
    }
    let status = result["status"].as_str().filter(|s| RESULTS.contains(s));
    let reason = result["reason"]
        .as_str()
        .filter(|r| HUMAN_STEPS.contains(r));
    let (filled, missing) = (kinds(result, "filled"), kinds(result, "missing"));
    let tab = &sent["tab"];
    let mut shaped = match status {
        Some("user_required") => {
            json!({"status":"user_required","reason":reason.unwrap_or("unknown_form"),
            "tab":tab,"filled":filled,"missing":missing,
            "recovery":"The user finishes this step in the tab; Butler waits for the hand-back."})
        }
        Some(status) => {
            json!({"status":status,"tab":tab,"filled":filled,"missing":missing,"url":result["url"]})
        }
        None => {
            json!({"status":result["status"].as_str().filter(|s| *s == "unknown").unwrap_or("not_dispatched"),
            "reason":result["reason"].as_str().filter(|r| r.len() <= 48).unwrap_or("fill_failed"),"tab":tab})
        }
    };
    if shaped["reason"] == "incompatible_target" {
        shaped["recovery"] = json!(
            "Observe and choose targets whose accessible label, autocomplete, name, input type and inputmode match each sensitive field kind."
        );
    }
    let outcome = match (shaped["status"].as_str(), shaped["reason"].as_str()) {
        (Some(status), Some(reason)) => format!("{status}:{reason}"),
        (Some(status), None) => status.to_owned(),
        _ => "unknown".into(),
    };
    let kind = if sent["args"]["kind"] == "card" {
        "card"
    } else {
        "profile"
    };
    state
        .application
        .vault(AppVaultCommand::Audit {
            kind,
            item_id: sent["args"]["item_id"].as_str().unwrap_or("").into(),
            session: session.into(),
            turn: sent["turn_id"].as_str().unwrap_or("").into(),
            origin: origin_of(result["url"].as_str().unwrap_or("")).unwrap_or_default(),
            frame_origin: origin_of(result["frame_origin"].as_str().unwrap_or(""))
                .unwrap_or_default(),
            result: outcome,
        })
        .await?;
    Ok(shaped)
}

/// `POST /internal/browser-host/vault/{token}` from main: single use, 10 s,
/// and only for the exact top-level origin and frame origins the token binds.
pub(super) async fn secrets(
    state: Arc<HttpState>,
    token: &str,
    body: &Value,
) -> Result<Response, HttpError> {
    let fill = state
        .browser
        .0
        .lock()
        .map_err(|_| HttpError::Internal)?
        .vault_fills
        .remove(token);
    let Some(fill) = fill.filter(|fill| fill.expires > Instant::now()) else {
        return Err(error(410, "fill_token_expired"));
    };
    if body["origin"].as_str() != Some(fill.top.as_str()) {
        return Err(error(403, "origin_mismatch"));
    }
    let frames: Vec<&str> = body["frame_origins"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    if frames.is_empty()
        || frames
            .iter()
            .any(|f| *f != fill.top && !fill.frames.iter().any(|b| b == f))
    {
        return Err(error(403, "origin_mismatch"));
    }
    let stored = signin_secrets::get_in(&state, vault::service(fill.kind), &fill.item)
        .await?
        .ok_or_else(|| error(404, "vault_secret_missing"))?;
    let fields = if fill.kind == "card" {
        vault::secret::CARD_FIELDS
    } else {
        vault::secret::AUTOFILL_FIELDS
    };
    let text = VaultSecret::parse(&stored, fields).to_text();
    let mut response = Response::new(Body::from(text.expose().as_bytes().to_vec()));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

/// Vault ops Rust answers or prepares before native dispatch.
pub(super) const VAULT_OPS: &[&str] =
    &["pay.lookup", "pay.allow_site", "pay.fill", "autofill.fill"];

/// `pay.lookup` answers here; `pay.fill` / `autofill.fill` mint their token first.
pub(super) async fn admit(
    state: &Arc<HttpState>,
    frame: &mut Value,
    op: &str,
    tab: &Value,
) -> Result<Option<Value>, HttpError> {
    if op == "pay.allow_site" {
        let site = merchant_site(state, tab);
        if site.is_empty() || frame["args"]["site"].as_str() != Some(site.as_str()) {
            return Err(error(400, "invalid_site"));
        }
        state
            .application
            .vault(AppVaultCommand::PurchaseSite {
                site: site.clone(),
                allow: true,
            })
            .await?;
        return Ok(Some(json!({"status":"ok","site":site})));
    }
    if op == "pay.lookup" {
        let mut value = lookup(state, tab).await?;
        if frame["schedule_browser"]["payment"] == false {
            value["purchase_allowed"] = json!(false);
            if let Some(cards) = value["cards"].as_array_mut() {
                for card in cards {
                    card["allowed"] = json!(false);
                }
            }
        }
        return Ok(Some(value));
    }
    prepare(state, frame, tab).await
}

/// After native dispatch: a fill's result (sign-in, card, autofill) is shaped and audited, and a
/// prepared batch learns whether its merchant site skips the final card.
pub(super) async fn finish_call(
    state: &Arc<HttpState>,
    op: &str,
    sent: &Value,
    session: &str,
    result: &mut Value,
) -> Result<(), HttpError> {
    if op == "signin.fill" {
        *result = super::fill::finish(state, sent, session, result).await?;
    } else if matches!(op, "pay.fill" | "autofill.fill") {
        *result = finish(state, sent, session, result).await?;
    } else if op == "tab.prepare" && result["status"] == "ok" {
        let tab = {
            let hub = state.browser.0.lock().map_err(|_| HttpError::Internal)?;
            hub.tabs.get(sent["tab"].as_str().unwrap_or("")).cloned()
        };
        if let Some(tab) = tab {
            result["purchase_allowed"] = json!(
                sent["schedule_browser"]["payment"] != false
                    && purchase_allowed(state, &tab).await?
            );
            result["merchant_site"] = json!(merchant_site(state, &tab));
        }
    }
    super::payment_scope::finish(state, op, sent, session, result).await
}
