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
        self.call(
            &stored,
            Method::PUT,
            "/v1/push/tokens",
            json!({"tokens": tokens}),
            204,
        )
        .await?;
        Ok(json!({}))
    }

    pub(super) async fn push(
        &self,
        messages: Vec<Value>,
        tokens: Vec<String>,
    ) -> Result<Value, GatewayApplicationError> {
        let stored = self.read().await?.ok_or_else(signed_out)?;
        let response: Value = self
            .call(
                &stored,
                Method::POST,
                "/v1/push/send",
                json!({"messages": messages}),
                200,
            )
            .await?
            .json()
            .await
            .map_err(|_| unavailable())?;
        let mut gone: Vec<_> = response["gone"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        let not_registered: BTreeSet<_> = response["not_registered"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        if !not_registered.is_empty() {
            self.call(
                &stored,
                Method::PUT,
                "/v1/push/tokens",
                json!({"tokens": tokens}),
                204,
            )
            .await?;
            let messages: Vec<_> = messages
                .into_iter()
                .filter(|message| {
                    message["to"]
                        .as_str()
                        .is_some_and(|token| not_registered.contains(token))
                })
                .collect();
            let response: Value = self
                .call(
                    &stored,
                    Method::POST,
                    "/v1/push/send",
                    json!({"messages": messages}),
                    200,
                )
                .await?
                .json()
                .await
                .map_err(|_| unavailable())?;
            gone.extend(
                response["gone"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_owned),
            );
        }
        Ok(json!({"gone": gone}))
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
