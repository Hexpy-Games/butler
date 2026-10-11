//! Autofill profile add and change. Birth date, passport and resident
//! registration numbers go only to the OS credential store; names, gender,
//! nationality, passport expiry and contact details are metadata.
use super::secret::{AUTOFILL_FIELDS, VaultSecret, take};
use super::{invalid, item_meta, not_found, unavailable};
use crate::gateway::http::{HttpError, HttpState, signin_secrets};
use crate::gateway::{AppProfileInput, AppVaultCommand};
use serde_json::{Value, json};
use std::sync::Arc;
use zeroize::Zeroizing;

const SERVICE: &str = signin_secrets::AUTOFILL_SERVICE;

fn date(value: &str) -> bool {
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
}

/// One metadata field: `(name, check)`; an empty string removes it.
fn detail_valid(name: &str, value: &str) -> bool {
    let latin = |v: &str| {
        v.chars().all(|c| {
            c.is_ascii_alphabetic()
                || ('\u{00c0}'..='\u{024f}').contains(&c)
                || matches!(c, ' ' | '-' | '\'' | '.')
        })
    };
    match name {
        "name" | "family_name" | "given_name" | "organization" | "region" | "city" => {
            value.chars().count() <= 120
        }
        "address_line1" | "address_line2" => value.chars().count() <= 240,
        "postal_code" => value.len() <= 20,
        "name_latin" | "name_latin_surname" | "name_latin_given" => {
            value.len() <= 60 && latin(value)
        }
        "gender" => matches!(value, "M" | "F"),
        "nationality" | "country" | "issuing_country" => {
            value.len() == 2 && value.chars().all(|c| c.is_ascii_uppercase())
        }
        "passport_expiry" => date(value),
        "phone" => {
            value.len() <= 32
                && value
                    .chars()
                    .all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | ' '))
        }
        "email" => value.len() <= 120 && value.contains('@'),
        _ => false,
    }
}

const DETAILS: &[&str] = &[
    "name",
    "family_name",
    "given_name",
    "name_latin",
    "organization",
    "country",
    "postal_code",
    "region",
    "city",
    "address_line1",
    "address_line2",
    "issuing_country",
    "name_latin_surname",
    "name_latin_given",
    "gender",
    "nationality",
    "passport_expiry",
    "phone",
    "email",
];

fn secret_valid(name: &str, value: &str) -> bool {
    match name {
        "birth_date" => date(value),
        "passport_number" => {
            (5..=12).contains(&value.len()) && value.chars().all(|c| c.is_ascii_alphanumeric())
        }
        "rrn" => value.len() == 13 && value.chars().all(|c| c.is_ascii_digit()),
        _ => false,
    }
}

pub(super) async fn save(
    state: &Arc<HttpState>,
    id: Option<&str>,
    mut body: Value,
) -> Result<Value, HttpError> {
    if !signin_secrets::available(state).await {
        return Err(unavailable());
    }
    let existing = match id {
        Some(id) => item_meta(state, "profile", id)
            .await?
            .ok_or_else(not_found)?,
        None => Value::Null,
    };
    let mut secret = match id {
        Some(id) => signin_secrets::get_in(state, SERVICE, id)
            .await?
            .map(|stored| VaultSecret::parse(&stored, AUTOFILL_FIELDS))
            .unwrap_or_default(),
        None => VaultSecret::default(),
    };
    for name in AUTOFILL_FIELDS {
        let Some(raw) = take(&mut body, name) else {
            continue;
        };
        let mut value = Zeroizing::new(String::with_capacity(raw.len()));
        for character in raw.trim().chars() {
            if *name == "birth_date" || character != '-' {
                value.push(character.to_ascii_uppercase());
            }
        }
        if !value.is_empty() && !secret_valid(name, &value) {
            return Err(invalid(name));
        }
        secret.set(name, value);
    }
    let (nickname, details) = details(&body, &existing)?;
    let input = AppProfileInput {
        nickname,
        details: Value::Object(details),
        extras: secret.names(),
    };
    store(state, id, input, &secret).await
}

async fn store(
    state: &Arc<HttpState>,
    id: Option<&str>,
    input: AppProfileInput,
    secret: &VaultSecret,
) -> Result<Value, HttpError> {
    if let Some(id) = id {
        signin_secrets::set_in(state, SERVICE, id, secret.to_text()).await?;
        return Ok(state
            .application
            .vault(AppVaultCommand::UpdateProfile {
                id: id.to_owned(),
                input,
            })
            .await?);
    }
    let saved = state
        .application
        .vault(AppVaultCommand::InsertProfile(input))
        .await?;
    let id = saved["id"].as_str().unwrap_or("").to_owned();
    if let Err(error) = signin_secrets::set_in(state, SERVICE, &id, secret.to_text()).await {
        state
            .application
            .vault(AppVaultCommand::Delete {
                kind: "profile",
                id,
            })
            .await?;
        return Err(error);
    }
    Ok(json!({"id": id}))
}

fn details(
    body: &Value,
    existing: &Value,
) -> Result<(String, serde_json::Map<String, Value>), HttpError> {
    let mut details = existing["details"].as_object().cloned().unwrap_or_default();
    for name in DETAILS {
        let Some(value) = body[*name].as_str().map(str::trim) else {
            continue;
        };
        if value.is_empty() {
            details.remove(*name);
        } else if detail_valid(name, value) {
            details.insert((*name).to_owned(), json!(value));
        } else {
            return Err(invalid(name));
        }
    }
    let fallback = details.get("name").and_then(Value::as_str).unwrap_or("");
    let nickname = body["nickname"]
        .as_str()
        .or_else(|| existing["nickname"].as_str())
        .map_or(fallback, str::trim)
        .chars()
        .take(40)
        .collect::<String>();
    if nickname.is_empty() {
        return Err(invalid("the nickname"));
    }
    Ok((nickname, details))
}

/// An identity number is disclosed only after OS user verification.
pub(super) async fn reveal(
    state: &Arc<HttpState>,
    id: &str,
    body: &Value,
) -> Result<Value, HttpError> {
    item_meta(state, "profile", id)
        .await?
        .ok_or_else(not_found)?;
    let reason = if body["locale"] == "ko" {
        "여권 번호를 보여 주려고 합니다"
    } else {
        "show the passport number"
    };
    let verified = tokio::task::spawn_blocking(move || {
        butler_platform::user_auth::verify(reason, std::time::Duration::from_secs(30))
    })
    .await
    .map_err(|_| HttpError::Internal)?;
    if verified.is_err() {
        return Err(HttpError::public(
            403,
            "user_verification_failed",
            "The computer did not verify you.",
        ));
    }
    let stored = signin_secrets::get_in(state, SERVICE, id)
        .await?
        .ok_or_else(not_found)?;
    let secret = VaultSecret::parse(&stored, AUTOFILL_FIELDS);
    Ok(json!({"number": secret.get("passport_number").unwrap_or("")}))
}
