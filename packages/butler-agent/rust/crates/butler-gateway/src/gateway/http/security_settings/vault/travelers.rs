//! Traveler profile add and change. Birth date, passport and resident
//! registration numbers go only to the OS credential store; names, gender,
//! nationality, passport expiry and contact details are metadata.
use super::secret::{TRAVELER_FIELDS, VaultSecret, take};
use super::{invalid, item_meta, not_found, unavailable};
use crate::gateway::http::{HttpError, HttpState, signin_secrets};
use crate::gateway::{AppTravelerInput, AppVaultCommand};
use serde_json::{Value, json};
use std::sync::Arc;
use zeroize::Zeroizing;

const SERVICE: &str = signin_secrets::TRAVELER_SERVICE;

fn date(value: &str) -> bool {
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
}

/// One metadata field: `(name, check)`; an empty string removes it.
fn detail_valid(name: &str, value: &str) -> bool {
    let latin = |v: &str| {
        v.chars()
            .all(|c| c.is_ascii_alphabetic() || matches!(c, ' ' | '-'))
    };
    match name {
        "name" => value.chars().count() <= 80,
        "name_latin_surname" | "name_latin_given" => value.len() <= 60 && latin(value),
        "gender" => matches!(value, "M" | "F"),
        "nationality" => value.len() == 2 && value.chars().all(|c| c.is_ascii_uppercase()),
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
        Some(id) => item_meta(state, "traveler", id)
            .await?
            .ok_or_else(not_found)?,
        None => Value::Null,
    };
    let mut secret = match id {
        Some(id) => signin_secrets::get_in(state, SERVICE, id)
            .await?
            .map(|stored| VaultSecret::parse(&stored, TRAVELER_FIELDS))
            .unwrap_or_default(),
        None => VaultSecret::default(),
    };
    for name in TRAVELER_FIELDS {
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
    let input = AppTravelerInput {
        nickname,
        details: Value::Object(details),
        extras: secret.names(),
    };
    store(state, id, input, &secret).await
}

async fn store(
    state: &Arc<HttpState>,
    id: Option<&str>,
    input: AppTravelerInput,
    secret: &VaultSecret,
) -> Result<Value, HttpError> {
    if let Some(id) = id {
        signin_secrets::set_in(state, SERVICE, id, secret.to_text()).await?;
        return Ok(state
            .application
            .vault(AppVaultCommand::UpdateTraveler {
                id: id.to_owned(),
                input,
            })
            .await?);
    }
    let saved = state
        .application
        .vault(AppVaultCommand::InsertTraveler(input))
        .await?;
    let id = saved["id"].as_str().unwrap_or("").to_owned();
    if let Err(error) = signin_secrets::set_in(state, SERVICE, &id, secret.to_text()).await {
        state
            .application
            .vault(AppVaultCommand::Delete {
                kind: "traveler",
                id,
            })
            .await?;
        return Err(error);
    }
    Ok(json!({"id": id}))
}
