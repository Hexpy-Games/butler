//! Canon online calls against butler-cloud, always with the caller's token.
use butler_gateway::gateway::GatewayApplicationError;
use reqwest::Method;
use serde_json::Value;

use super::butler_account::{ButlerAccount, check, signed_out, unavailable};

/// The signed-in account, read once per request or worker pass.
pub(crate) struct CloudIdentity {
    pub token: String,
    pub account_id: String,
    pub device_id: String,
}

impl ButlerAccount {
    pub(crate) async fn identity(&self) -> Result<Option<CloudIdentity>, GatewayApplicationError> {
        Ok(self.read().await?.map(|stored| CloudIdentity {
            token: stored.device_token,
            account_id: stored.account_id,
            device_id: stored.device_id,
        }))
    }

    /// The account file has no email; `/v1/me` does.
    pub(crate) async fn email(&self, token: &str) -> Result<String, GatewayApplicationError> {
        let response = self.send(Method::GET, "/v1/me", Some(token), None).await?;
        if response.status().as_u16() == 401 {
            return Err(signed_out());
        }
        let value: Value = check(response, 200)
            .await?
            .json()
            .await
            .map_err(|_| unavailable())?;
        value["account"]["email"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(unavailable)
    }

    pub(crate) async fn canon(
        &self,
        token: &str,
        method: Method,
        path: &str,
        body: Option<Value>,
        expected: u16,
    ) -> Result<Value, GatewayApplicationError> {
        let response = self
            .send(method, &format!("/v1/canon{path}"), Some(token), body)
            .await?;
        if response.status().as_u16() == 401 {
            return Err(signed_out());
        }
        let response = check(response, expected).await?;
        if expected == 204 {
            return Ok(Value::Null);
        }
        response.json().await.map_err(|_| unavailable())
    }

    /// Status, `Retry-After` seconds and body, for callers that branch on status.
    pub(crate) async fn canon_raw(
        &self,
        token: &str,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<(u16, Option<u64>, Value), GatewayApplicationError> {
        let response = self
            .send(method, &format!("/v1/canon{path}"), Some(token), body)
            .await?;
        let status = response.status().as_u16();
        let retry = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok());
        Ok((status, retry, response.json().await.unwrap_or(Value::Null)))
    }
}
