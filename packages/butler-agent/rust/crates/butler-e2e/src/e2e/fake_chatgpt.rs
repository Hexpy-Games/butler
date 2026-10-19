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

#[allow(
    clippy::struct_excessive_bools,
    reason = "independent programmable protocol faults"
)]
#[derive(Clone, Default)]
pub struct Faults {
    pub deny: bool,
    pub omit_client: bool,
    pub wrong_client: bool,
    pub wrong_state: bool,
    pub id_token: Option<String>,
    pub no_plan: bool,
    pub invalid_grant: bool,
    pub revoke_503: bool,
    pub refresh_503: bool,
    pub invalid_client: bool,
    pub refresh_reused: bool,
    pub models_401: usize,
    pub models_503: usize,
    pub subject: Option<String>,
}
#[derive(Clone)]
pub struct Seen {
    pub path: String,
    pub params: BTreeMap<String, String>,
}
pub(super) struct State {
    pub issuer: String,
    pub refresh: Mutex<BTreeMap<String, String>>,
    pub models: Mutex<Vec<Value>>,
    pub faults: Mutex<Faults>,
    pub seen: Mutex<Vec<Seen>>,
    pub grants: Mutex<BTreeMap<String, BTreeMap<String, String>>>,
    pub registrations: Mutex<usize>,
    pub clients: Mutex<BTreeSet<String>>,
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
            issuer: issuer.clone(),
            refresh: Mutex::new(BTreeMap::new()),
            models: Mutex::new(models::defaults()),
            faults: Mutex::new(Faults::default()),
            seen: Mutex::new(Vec::new()),
            grants: Mutex::new(BTreeMap::new()),
            registrations: Mutex::new(0),
            clients: Mutex::new(BTreeSet::new()),
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
    pub fn stop(&self) {
        self.task.abort();
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
    pub fn faults(&self, faults: Faults) {
        *self
            .state
            .faults
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = faults;
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
    fn record(&self, path: &str, params: &BTreeMap<String, String>) {
        self.seen
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(Seen {
                path: path.into(),
                params: params.clone(),
            });
    }
    fn faults(&self) -> Faults {
        self.faults
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}
