//! Serialized, cancellation-safe rotation of an official ChatGPT token set.
use super::{RESOURCE, authority, store};
use crate::models::configuration::auth::{AuthError, AuthOwner, chatgpt_error};
use serde_json::Value;

pub(in crate::models::configuration) async fn resolve(
    owner: &AuthOwner<'_>,
    paths: store::Paths,
    raw: Value,
    rejected: Option<&str>,
) -> Result<Value, AuthError> {
    let now = owner.clock.now_epoch_millis();
    let forced = rejected.is_some_and(|v| {
        raw["access_token"]
            .as_str()
            .is_some_and(|t| v == format!("Bearer {t}"))
    });
    let expiry = raw["expires_at"].as_i64().unwrap_or(0);
    let earliest = raw["earliest_refresh_at"].as_i64().unwrap_or(0);
    if !forced && (now < expiry.saturating_sub(300_000) || (now < expiry && now < earliest)) {
        return Ok(raw);
    }
    let client = butler_log::http::external(butler_log::http::Purpose::new("oauth"))
        .redirect(butler_log::http::RedirectPolicy::none())
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|_| chatgpt_error("provider_auth_refresh_unavailable"))?;
    let clock = owner.clock.clone();
    let revision = owner.revision.clone();
    tokio::spawn(async move {
        let path = paths.registration.clone();
        let (lock, current) = tokio::task::spawn_blocking(move || {
            let lock = butler_core::configuration::lock_file(&path)
                .map_err(|_| "provider_auth_lock_failed")?;
            let raw = store::read_sync(&path)?;
            Ok::<_, &'static str>((lock, raw))
        })
        .await
        .map_err(|_| chatgpt_error("provider_auth_lock_failed"))?
        .map_err(chatgpt_error)?;
        let _lock = lock;
        if ["access_token", "refresh_token", "client_id"]
            .iter()
            .any(|k| raw[*k] != current[*k])
        {
            return Ok(current);
        }
        let outcome = exchange(&client, &current).await;
        let Some(token) = outcome else {
            return if clock.now_epoch_millis() < expiry {
                Ok(current)
            } else {
                Err(chatgpt_error("provider_auth_refresh_unavailable"))
            };
        };
        let mut updated = current.clone();
        let terminal = terminal(&token);
        if let Some(reason) = terminal {
            updated["access_token"] = Value::Null;
            updated["refresh_token"] = Value::Null;
            updated["sign_in_required"] = reason.into();
            if reason == "client_invalid" {
                updated["client_id"] = Value::Null;
            }
        } else {
            rotate(&mut updated, &token, clock.now_epoch_millis());
        }
        updated["updated_at"] = clock.now_iso().into();
        let changed = terminal.is_some() || current["scopes"] != updated["scopes"];
        let bytes = serde_json::to_vec_pretty(&updated)
            .map_err(|_| chatgpt_error("provider_auth_write_failed"))?;
        super::super::auth::io::write_mode_600(&paths.registration, &bytes).await?;
        if changed {
            revision.send_modify(|v| *v = v.wrapping_add(1));
        }
        if terminal.is_some() {
            return Err(chatgpt_error("chatgpt_sign_in_required"));
        }
        Ok(updated)
    })
    .await
    .map_err(|_| chatgpt_error("provider_auth_refresh_unavailable"))?
}
async fn exchange(client: &butler_log::http::Client, raw: &Value) -> Option<Value> {
    let issuer = raw["issuer"].as_str()?.trim_end_matches('/');
    let mut response = client
        .post(format!("{issuer}/api/accounts/oauth/token"))
        .timeout(std::time::Duration::from_secs(10))
        .header("accept", "application/json")
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", raw["client_id"].as_str()?),
            ("refresh_token", raw["refresh_token"].as_str()?),
            ("resource", RESOURCE),
        ])
        .send()
        .await
        .ok()?;
    if response.status().is_server_error() || response.status().as_u16() == 429 {
        return None;
    }
    let success = response.status().as_u16() == 200;
    let value = authority::response_value(&mut response).await.ok()?;
    if terminal(&value).is_some()
        || (success
            && value["access_token"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
            && value
                .get("token_type")
                .is_none_or(|v| v.as_str().is_some_and(|s| s.eq_ignore_ascii_case("Bearer"))))
    {
        Some(value)
    } else {
        None
    }
}
fn terminal(token: &Value) -> Option<&'static str> {
    match token["error"]
        .as_str()
        .or_else(|| token.pointer("/error/code").and_then(Value::as_str))?
    {
        "invalid_client" => Some("client_invalid"),
        "invalid_grant"
        | "invalid_refresh_token"
        | "token_expired"
        | "refresh_token_expired"
        | "refresh_token_invalidated"
        | "refresh_token_reused" => Some("refresh_rejected"),
        _ => None,
    }
}
fn rotate(raw: &mut Value, token: &Value, now: i64) {
    raw["access_token"] = token["access_token"].clone();
    if let Some(refresh) = token["refresh_token"].as_str().filter(|s| !s.is_empty()) {
        raw["refresh_token"] = refresh.into();
    }
    for key in ["access_token", "refresh_token"] {
        if let Some(secret) = raw[key].as_str() {
            butler_log::register_secret(secret);
        }
    }
    raw["expires_at"] = now
        .saturating_add(
            token["expires_in"]
                .as_i64()
                .unwrap_or(3600)
                .saturating_mul(1000),
        )
        .into();
    if let Some(scope) = token["scope"].as_str() {
        raw["scopes"] = serde_json::json!(scope.split_whitespace().collect::<Vec<_>>());
    }
    raw["earliest_refresh_at"] = token["earliest_refresh_at"]
        .as_i64()
        .and_then(|n| n.checked_mul(1000))
        .into();
}
