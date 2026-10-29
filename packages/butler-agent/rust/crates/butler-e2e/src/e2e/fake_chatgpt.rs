//! Stub-only authority using the documented SIWC protocol, never a live service.
mod authority;
mod models;
mod tokens;
use super::{HarnessError, harness_error};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};
use tokio::task::JoinHandle;

#[derive(Clone)]
pub struct Seen {
    pub path: String,
    pub params: BTreeMap<String, String>,
    pub headers: BTreeMap<String, String>,
}
pub(super) struct State {
    pub revoke_delay: Mutex<std::time::Duration>,
    pub issuer: String,
    pub refresh: Mutex<BTreeMap<String, String>>,
    pub models: Mutex<Vec<Value>>,
    pub seen: Mutex<Vec<Seen>>,
    pub grants: Mutex<BTreeMap<String, BTreeMap<String, String>>>,
    pub registrations: Mutex<usize>,
    pub clients: Mutex<BTreeSet<String>>,
    /// Every code and token this authority handed out, in issue order.
    pub issued: Mutex<Vec<String>>,
}
pub struct FakeChatGptAuthority {
    pub issuer: String,
    state: Arc<State>,
    task: JoinHandle<()>,
}
impl FakeChatGptAuthority {
    pub async fn start() -> Result<Self, HarnessError> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let issuer = format!("http://{}", listener.local_addr()?);
        let state = Arc::new(State {
            revoke_delay: Mutex::new(std::time::Duration::ZERO),
            issuer: issuer.clone(),
            refresh: Mutex::new(BTreeMap::new()),
            models: Mutex::new(models::defaults()),
            seen: Mutex::new(Vec::new()),
            grants: Mutex::new(BTreeMap::new()),
            registrations: Mutex::new(0),
            clients: Mutex::new(BTreeSet::new()),
            issued: Mutex::new(Vec::new()),
        });
        let router = authority::router(state.clone());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        Ok(Self {
            issuer,
            state,
            task,
        })
    }
    pub fn revoke_delay(&self, delay: std::time::Duration) {
        *self
            .state
            .revoke_delay
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = delay;
    }
    pub fn models(&self, models: Vec<Value>) {
        *self
            .state
            .models
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = models;
    }
    pub fn registration(&self) -> Value {
        let client = "oaiapp_e2e_0001";
        self.state
            .clients
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(client.into());
        let token = tokens::issue(&self.state, client);
        serde_json::json!({"schema_version":1, "issuer":self.issuer, "client_id":client,
            "subject":"e2e-subject", "email":"e2e-user@example.com", "token_type":"Bearer",
            "access_token":token["access_token"], "refresh_token":token["refresh_token"],
            "expires_at":chrono::Utc::now().timestamp_millis()+3_600_000,
            "scopes":butler_models::models::chatgpt::SCOPES.split_whitespace().collect::<Vec<_>>(),
            "plan_notice_acknowledged_at":chrono::Utc::now().to_rfc3339()})
    }
    /// The secret values (authorization codes, access, refresh and ID tokens) issued so far.
    pub fn issued(&self) -> Vec<String> {
        self.state
            .issued
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
    pub fn seen(&self) -> Vec<Seen> {
        self.state
            .seen
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
    pub async fn browser(&self, flow: &Value) -> Result<(u16, String), HarnessError> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let response = client
            .get(
                flow["auth_url"]
                    .as_str()
                    .ok_or_else(|| harness_error("missing auth URL"))?,
            )
            .send()
            .await?;
        let location = response
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| harness_error("authorize did not redirect"))?;
        let response = client.get(location).send().await?;
        Ok((response.status().as_u16(), response.text().await?))
    }
}
impl Drop for FakeChatGptAuthority {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl State {
    fn issue(&self, secret: &str) {
        self.issued
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(secret.into());
    }
    fn record(
        &self,
        path: &str,
        params: &BTreeMap<String, String>,
        headers: &axum::http::HeaderMap,
    ) {
        self.seen
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(Seen {
                path: path.into(),
                params: params.clone(),
                headers: headers
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or_default().to_owned()))
                    .collect(),
            });
    }
}
