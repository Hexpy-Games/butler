//! Card add, change and reveal. The number, CVC and optional PIN digits are
//! validated in wiped memory and written only to the OS credential store.
use super::secret::{CARD_FIELDS, VaultSecret, brand, digits, luhn, take};
use super::{invalid, item_meta, not_found, unavailable};
use crate::gateway::http::{HttpError, HttpState, signin_secrets};
use crate::gateway::{AppCardInput, AppVaultCommand};
use chrono::Datelike;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use zeroize::Zeroizing;

const SERVICE: &str = signin_secrets::PAYMENT_SERVICE;
const REVEAL_TIMEOUT: Duration = Duration::from_secs(120);
const BILLING_FIELDS: &[&str] = &[
    "postal_code",
    "address1",
    "address2",
    "city",
    "region",
    "country",
    "phone",
    "email",
];

fn number(raw: &str) -> Result<Zeroizing<String>, HttpError> {
    digits(raw)
        .filter(|n| (12..=19).contains(&n.len()) && luhn(n))
        .ok_or_else(|| invalid("the card number"))
}

/// `(month, four-digit year)`; a card already expired is refused.
fn expiry(body: &Value, current: Option<(u32, u32)>) -> Result<(u32, u32), HttpError> {
    let read = |name: &str| {
        body[name]
            .as_u64()
            .or_else(|| body[name].as_str()?.trim().parse().ok())
    };
    let month = read("exp_month").map_or(current.map(|c| c.0), |m| u32::try_from(m).ok());
    let year = read("exp_year").map_or(current.map(|c| c.1), |y| u32::try_from(y).ok());
    let (Some(month), Some(mut year)) = (month, year) else {
        return Err(invalid("the expiry date"));
    };
    if year < 100 {
        year += 2000;
    }
    let today = chrono::Utc::now();
    let now = (u32::try_from(today.year()).unwrap_or(0), today.month());
    if !(1..=12).contains(&month) || year > now.0 + 30 || (year, month) < now {
        return Err(invalid("the expiry date"));
    }
    Ok((month, year))
}

/// Optional secrets: an empty string removes one; anything else must be valid.
fn optional_secrets(body: &mut Value, secret: &mut VaultSecret) -> Result<(), HttpError> {
    for (name, lengths, label) in [
        ("cvc", 3..=4, "the CVC"),
        ("pin2", 2..=2, "the PIN digits"),
        ("owner_id", 6..=10, "the birth date or business number"),
    ] {
        let Some(raw) = take(body, name) else {
            continue;
        };
        let value = digits(&raw).ok_or_else(|| invalid(label))?;
        if !value.is_empty() && !lengths.contains(&value.len()) {
            return Err(invalid(label));
        }
        secret.set(name, value);
    }
    Ok(())
}

fn text(body: &Value, name: &str, max: usize, fallback: &str) -> Result<String, HttpError> {
    match body.get(name) {
        Some(Value::String(value)) if value.chars().count() <= max => Ok(value.trim().to_owned()),
        Some(Value::String(_)) => Err(invalid(name)),
        _ => Ok(fallback.to_owned()),
    }
}

fn billing(body: &Value, existing: &Value) -> Result<Value, HttpError> {
    let Some(source) = body.get("billing") else {
        return Ok(existing.clone());
    };
    let mut out = serde_json::Map::new();
    for field in BILLING_FIELDS {
        if let Some(value) = source[*field]
            .as_str()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            if value.chars().count() > 120 {
                return Err(invalid("the billing address"));
            }
            out.insert((*field).to_owned(), json!(value));
        }
    }
    Ok(Value::Object(out))
}

fn metadata(
    body: &Value,
    existing: &Value,
    secret: &VaultSecret,
    (exp_month, exp_year): (u32, u32),
) -> Result<AppCardInput, HttpError> {
    let number = secret
        .get("number")
        .ok_or_else(|| invalid("the card number"))?;
    let last4 = number
        .get(number.len().saturating_sub(4)..)
        .unwrap_or("")
        .to_owned();
    let brand = brand(number).to_owned();
    let fallback = existing["nickname"]
        .as_str()
        .map_or_else(|| format!("{brand} {last4}"), str::to_owned);
    let mut nickname = text(body, "nickname", 40, &fallback)?;
    if nickname.is_empty() {
        nickname = format!("{brand} {last4}");
    }
    Ok(AppCardInput {
        nickname,
        brand,
        last4,
        exp_month,
        exp_year,
        holder_name: text(
            body,
            "holder_name",
            80,
            existing["holder_name"].as_str().unwrap_or(""),
        )?,
        billing: billing(body, &existing["billing"])?,
        extras: secret
            .names()
            .into_iter()
            .filter(|n| n == "pin2" || n == "owner_id")
            .collect(),
    })
}

pub(super) async fn add(state: &Arc<HttpState>, mut body: Value) -> Result<Value, HttpError> {
    if !signin_secrets::available(state).await {
        return Err(unavailable());
    }
    let mut secret = VaultSecret::default();
    let raw = take(&mut body, "number").ok_or_else(|| invalid("the card number"))?;
    secret.set("number", number(&raw)?);
    optional_secrets(&mut body, &mut secret)?;
    let input = metadata(&body, &Value::Null, &secret, expiry(&body, None)?)?;
    let saved = state
        .application
        .vault(AppVaultCommand::InsertCard(input))
        .await?;
    let id = saved["id"].as_str().unwrap_or("").to_owned();
    if let Err(error) = signin_secrets::set_in(state, SERVICE, &id, secret.to_text()).await {
        state
            .application
            .vault(AppVaultCommand::Delete { kind: "card", id })
            .await?;
        return Err(error);
    }
    Ok(json!({"id": id}))
}

pub(super) async fn update(
    state: &Arc<HttpState>,
    id: &str,
    mut body: Value,
) -> Result<Value, HttpError> {
    if !signin_secrets::available(state).await {
        return Err(unavailable());
    }
    let existing = item_meta(state, "card", id).await?.ok_or_else(not_found)?;
    let stored = signin_secrets::get_in(state, SERVICE, id)
        .await?
        .ok_or_else(not_found)?;
    let mut secret = VaultSecret::parse(&stored, CARD_FIELDS);
    drop(stored);
    let before = secret.to_text();
    if let Some(raw) = take(&mut body, "number") {
        secret.set("number", number(&raw)?);
    }
    optional_secrets(&mut body, &mut secret)?;
    let current = (
        u32::try_from(existing["exp_month"].as_u64().unwrap_or(0)).unwrap_or(0),
        u32::try_from(existing["exp_year"].as_u64().unwrap_or(0)).unwrap_or(0),
    );
    let input = metadata(&body, &existing, &secret, expiry(&body, Some(current))?)?;
    let after = secret.to_text();
    if after.expose() != before.expose() {
        signin_secrets::set_in(state, SERVICE, id, after).await?;
    }
    Ok(state
        .application
        .vault(AppVaultCommand::UpdateCard {
            id: id.to_owned(),
            input,
        })
        .await?)
}

/// The full number, only after the user verifies themselves to the OS.
pub(super) async fn reveal(
    state: &Arc<HttpState>,
    id: &str,
    body: &Value,
) -> Result<Value, HttpError> {
    if !signin_secrets::available(state).await {
        return Err(unavailable());
    }
    let card = item_meta(state, "card", id).await?.ok_or_else(not_found)?;
    let last4 = card["last4"].as_str().unwrap_or("").to_owned();
    let reason = if body["locale"] == "ko" {
        format!("끝자리 {last4} 카드 번호를 보여 주려고 합니다")
    } else {
        format!("show the card number ending in {last4}")
    };
    let verified = tokio::task::spawn_blocking(move || {
        butler_platform::user_auth::verify(&reason, REVEAL_TIMEOUT)
    })
    .await
    .map_err(|_| HttpError::Internal)?;
    if let Err(error) = verified {
        return Err(HttpError::public(
            403,
            "user_verification_failed",
            &format!("The computer did not verify you ({}).", error.code()),
        ));
    }
    let stored = signin_secrets::get_in(state, SERVICE, id)
        .await?
        .ok_or_else(not_found)?;
    let secret = VaultSecret::parse(&stored, CARD_FIELDS);
    Ok(json!({"number": secret.get("number").unwrap_or("")}))
}
