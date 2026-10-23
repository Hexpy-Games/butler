use super::super::ModelConfiguration;
use super::{Error, RESOURCE, SignInAttempt, SignInOutcome, authority, id_token, store};
use serde_json::{Value, json};
use std::collections::BTreeMap;

impl ModelConfiguration {
    pub async fn chatgpt_exchange(
        &self,
        attempt: &SignInAttempt,
        params: &BTreeMap<String, String>,
        code: &str,
        redirect: &str,
    ) -> Result<Value, Error> {
        let client = callback_client(attempt, params)?;
        let paths = self.chatgpt_paths().await?;
        retain_pending(&paths, attempt, &client).await?;
        let mut response = self
            .chatgpt_authority
            .client()?
            .post(&attempt.discovery.token_endpoint)
            .phase(butler_log::http::Phase::current().sensitive())
            .header(reqwest::header::ACCEPT, "application/json")
            .form(&[
                ("grant_type", "authorization_code"),
                ("client_id", client.as_str()),
                ("code", code),
                ("code_verifier", &attempt.verifier),
                ("redirect_uri", redirect),
                ("resource", RESOURCE),
            ])
            .send()
            .await
            .map_err(|_| "oauth_exchange_failed")?;
        let success = response.status() == reqwest::StatusCode::OK;
        let token = authority::response_value(&mut response).await?;
        if !success {
            return Err(
                if token["error"] == "invalid_grant"
                    || token
                        .pointer("/error/code")
                        .is_some_and(|c| c == "invalid_grant")
                {
                    "oauth_code_expired"
                } else {
                    "oauth_exchange_failed"
                },
            );
        }
        validate_response(&token)?;
        let claims = id_token::verify(
            &self.chatgpt_authority,
            &attempt.discovery,
            token["id_token"]
                .as_str()
                .ok_or("oauth_exchange_incomplete")?,
            &client,
            &attempt.nonce,
            self.clock.now_epoch_millis() / 1000,
        )
        .await?;
        if !attempt.new_registration
            && let Some(subject) = attempt.registration["subject"].as_str()
            && claims["sub"] != subject
        {
            return Err("oauth_account_mismatch");
        }
        Ok(registration(
            attempt,
            &client,
            &token,
            &claims,
            self.clock.now_epoch_millis(),
            &self.clock.now_iso(),
        ))
    }
    pub async fn chatgpt_save(&self, registration: Value) -> Result<SignInOutcome, Error> {
        let paths = self.chatgpt_paths().await?;
        let label = super::label(&registration);
        let plan_enabled = super::plan_enabled(&registration);
        store::update(&paths, paths.registration.clone(), move |raw| {
            let object = raw.as_object_mut().ok_or("oauth_profile_write_failed")?;
            object.extend(
                registration
                    .as_object()
                    .ok_or("oauth_profile_write_failed")?
                    .clone(),
            );
            Ok(())
        })
        .await?;
        store::delete_legacy(&paths).await;
        self.chatgpt_invalidate_models().await;
        self.chatgpt_changed();
        Ok(SignInOutcome {
            label,
            plan_enabled,
        })
    }
}
async fn retain_pending(
    paths: &store::Paths,
    attempt: &SignInAttempt,
    client: &str,
) -> Result<(), Error> {
    if attempt.new_registration && !super::signed_in(&attempt.registration) {
        let issued = client.to_owned();
        let issuer = attempt.discovery.issuer.clone();
        store::update(paths, paths.registration.clone(), move |raw| {
            if super::signed_in(raw) {
                return Err("oauth_account_mismatch");
            }
            raw["schema_version"] = 1.into();
            raw["issuer"] = issuer.into();
            raw["client_id"] = issued.into();
            raw["subject"] = Value::Null;
            Ok(())
        })
        .await?;
    }
    Ok(())
}
fn callback_client(
    attempt: &SignInAttempt,
    params: &BTreeMap<String, String>,
) -> Result<String, Error> {
    if attempt.new_registration {
        params
            .get("client_id")
            .filter(|id| !id.is_empty() && id.as_str() != super::DYNAMIC_CLIENT)
            .cloned()
            .ok_or("oauth_registration_incomplete")
    } else if params
        .get("client_id")
        .is_some_and(|id| id != &attempt.client_id)
    {
        Err("oauth_client_mismatch")
    } else {
        Ok(attempt.client_id.clone())
    }
}
fn validate_response(token: &Value) -> Result<(), Error> {
    if ["access_token", "refresh_token", "id_token"]
        .iter()
        .any(|key| token[*key].as_str().is_none_or(str::is_empty))
        || !token["token_type"]
            .as_str()
            .is_some_and(|s| s.eq_ignore_ascii_case("Bearer"))
    {
        return Err("oauth_exchange_incomplete");
    }
    for key in ["access_token", "refresh_token"] {
        if let Some(secret) = token[key].as_str() {
            butler_log::register_secret(secret);
        }
    }
    Ok(())
}
fn registration(
    attempt: &SignInAttempt,
    client: &str,
    token: &Value,
    claims: &Value,
    now: i64,
    iso: &str,
) -> Value {
    let scopes = token["scope"]
        .as_str()
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>();
    let mut registration = json!({"schema_version":1, "issuer":attempt.discovery.issuer,
        "client_id":client, "subject":claims["sub"], "email":claims["email"], "name":claims["name"],
        "access_token":token["access_token"], "refresh_token":token["refresh_token"], "token_type":"Bearer",
        "expires_at":now.saturating_add(token["expires_in"].as_i64().unwrap_or(3600).saturating_mul(1000)),
        "earliest_refresh_at":token["earliest_refresh_at"].as_i64().and_then(|s| s.checked_mul(1000)),
        "scopes":scopes, "sign_in_required":null, "plan_notice_acknowledged_at":null, "signed_in_at":iso, "updated_at":iso});
    if attempt.registration["client_id"] == client {
        registration["plan_notice_acknowledged_at"] =
            attempt.registration["plan_notice_acknowledged_at"].clone();
    }
    registration
}
