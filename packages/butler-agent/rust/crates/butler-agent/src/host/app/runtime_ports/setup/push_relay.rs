use std::collections::BTreeSet;

use butler_gateway::gateway::GatewayApplicationError;
use reqwest::{Method, Response};
use serde_json::{Value, json};

use super::butler_account::{ButlerAccount, StoredAccount, check, signed_out, unavailable};

impl ButlerAccount {
    pub(super) async fn push_tokens(
        &self,
        tokens: Vec<String>,
    ) -> Result<Value, GatewayApplicationError> {
        let stored = self.read().await?.ok_or_else(signed_out)?;
        self.register(&stored, &tokens).await?;
        Ok(json!({}))
    }

    pub(super) async fn push(
        &self,
        messages: Vec<Value>,
        tokens: Vec<String>,
    ) -> Result<Value, GatewayApplicationError> {
        let stored = self.read().await?.ok_or_else(signed_out)?;
        let first = self.send_messages(&stored, &messages).await?;
        let mut gone: Vec<String> = strs(&first["gone"]).map(str::to_owned).collect();
        let missing: BTreeSet<&str> = strs(&first["not_registered"]).collect();
        if !missing.is_empty() {
            self.register(&stored, &tokens).await?;
            let retry: Vec<Value> = messages
                .iter()
                .filter(|message| {
                    message["to"]
                        .as_str()
                        .is_some_and(|to| missing.contains(to))
                })
                .cloned()
                .collect();
            let second = self.send_messages(&stored, &retry).await?;
            gone.extend(strs(&second["gone"]).map(str::to_owned));
        }
        Ok(json!({"gone": gone}))
    }

    async fn register(
        &self,
        stored: &StoredAccount,
        tokens: &[String],
    ) -> Result<(), GatewayApplicationError> {
        let body = json!({"tokens": tokens});
        self.call(stored, Method::PUT, "/v1/push/tokens", body, 204)
            .await
            .map(drop)
    }

    async fn send_messages(
        &self,
        stored: &StoredAccount,
        messages: &[Value],
    ) -> Result<Value, GatewayApplicationError> {
        let body = json!({"messages": messages});
        self.call(stored, Method::POST, "/v1/push/send", body, 200)
            .await?
            .json()
            .await
            .map_err(|_| unavailable())
    }

    async fn call(
        &self,
        stored: &StoredAccount,
        method: Method,
        path: &str,
        body: Value,
        expected: u16,
    ) -> Result<Response, GatewayApplicationError> {
        let response = self
            .send(method, path, Some(&stored.device_token), Some(body))
            .await?;
        if response.status().as_u16() == 401 {
            self.delete().await?;
            return Err(signed_out());
        }
        check(response, expected).await
    }
}

fn strs(value: &Value) -> impl Iterator<Item = &str> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
}
