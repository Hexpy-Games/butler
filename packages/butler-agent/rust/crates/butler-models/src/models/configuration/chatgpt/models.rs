//! Change-driven account catalog discovery with an offline persisted snapshot.
use super::{Error, registration, store};
use crate::models::{ModelConfiguration, ProviderAuth};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;
#[derive(Clone, Deserialize, Serialize)]
pub struct Model {
    pub slug: String,
    pub display_name: String,
}
#[derive(Clone, Deserialize, Serialize)]
struct Cached {
    schema_version: u8,
    registration: String,
    fetched_at: i64,
    models: Vec<Model>,
}
#[derive(Default)]
pub(in crate::models::configuration) struct Cache {
    inner: Mutex<State>,
}
#[derive(Default)]
struct State {
    cached: Option<Cached>,
    loaded: bool,
    attempted_at: Option<i64>,
}
impl ModelConfiguration {
    pub fn chatgpt_api_base(&self) -> &str {
        self.environment
            .chatgpt_api_base_url
            .as_deref()
            .unwrap_or(super::DEFAULT_API_BASE)
            .trim_end_matches('/')
    }
    pub async fn chatgpt_invalidate_models(&self) {
        *self.chatgpt_models.inner.lock().await = State::default();
        let _ = tokio::fs::remove_file(self.data_root.join("cache/chatgpt-models.json")).await;
        crate::models::provider::chatgpt_plan::clear();
    }
    pub async fn chatgpt_models(&self) -> Result<Option<Vec<Model>>, Error> {
        let paths = self.chatgpt_paths().await?;
        let raw = store::read(&paths.registration).await?;
        let Some(registration) = registration(&raw) else {
            return Ok(None);
        };
        if !super::signed_in(&raw) || !super::plan_enabled(&raw) {
            return Ok(None);
        }
        self.chatgpt_models_for(&registration).await
    }
    async fn chatgpt_models_for(&self, registration: &str) -> Result<Option<Vec<Model>>, Error> {
        let mut state = self.chatgpt_models.inner.lock().await;
        let path = self.data_root.join("cache/chatgpt-models.json");
        if !state.loaded {
            state.cached = tokio::fs::read(&path)
                .await
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok());
            state.loaded = true;
        }
        if state
            .cached
            .as_ref()
            .is_some_and(|c| c.schema_version != 1 || c.registration != registration)
        {
            state.cached = None;
            state.attempted_at = None;
            crate::models::provider::chatgpt_plan::clear();
        }
        let now = self.clock.now_epoch_millis();
        let stale = state
            .cached
            .as_ref()
            .is_none_or(|c| now.saturating_sub(c.fetched_at) >= 21_600_000);
        let due = state
            .attempted_at
            .is_none_or(|at| now.saturating_sub(at) >= 21_600_000);
        if state.cached.is_none() || (stale && due) {
            state.attempted_at = Some(now);
            let outcome = match self.chatgpt_auth(None).await {
                Ok(mut token) => self.fetch_chatgpt_models(&mut token).await,
                Err(code) => Err(code),
            };
            if let Ok(models) = outcome {
                let cached = Cached {
                    schema_version: 1,
                    registration: registration.to_owned(),
                    fetched_at: now,
                    models,
                };
                persist(&path, &cached).await;
                state.cached = Some(cached);
            }
        }
        Ok(state.cached.as_ref().map(|c| c.models.clone()))
    }
    async fn fetch_chatgpt_models(
        &self,
        authorization: &mut zeroize::Zeroizing<String>,
    ) -> Result<Vec<Model>, Error> {
        for attempt in 0..2 {
            let mut response = self
                .client
                .get(format!("{}/models", self.chatgpt_api_base()))
                .timeout(std::time::Duration::from_secs(10))
                .header("authorization", authorization.as_str())
                .purpose(butler_log::http::Purpose::new("provider_models"))
                .send()
                .await
                .map_err(|_| "provider_model_unavailable")?;
            if response.status().as_u16() == 401 && attempt == 0 {
                *authorization = self.chatgpt_auth(Some(authorization.as_str())).await?;
                continue;
            }
            if !response.status().is_success() {
                return Err("provider_model_unavailable");
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| "provider_model_unavailable")?
            {
                if bytes.len() + chunk.len() > 1024 * 1024 {
                    return Err("provider_model_unavailable");
                }
                bytes.extend_from_slice(&chunk);
            }
            let body: Value =
                serde_json::from_slice(&bytes).map_err(|_| "provider_model_unavailable")?;
            return body["models"]
                .as_array()
                .ok_or("provider_model_unavailable")
                .map(|models| {
                    models
                        .iter()
                        .filter(|v| v["visibility"] == "list")
                        .filter_map(|v| {
                            Some(Model {
                                slug: v["slug"].as_str()?.into(),
                                display_name: v["display_name"].as_str()?.into(),
                            })
                        })
                        .collect()
                });
        }
        Err("provider_model_unavailable")
    }
    async fn chatgpt_auth(
        &self,
        rejected: Option<&str>,
    ) -> Result<zeroize::Zeroizing<String>, Error> {
        let paths = self.chatgpt_paths().await?;
        let mut environment = self.environment.clone();
        environment.chatgpt_auth_dir = paths.registration.parent().map(std::path::Path::to_owned);
        let auth = super::super::auth::AuthOwner {
            data_root: &self.data_root,
            environment: &environment,
            clock: &self.clock,
            revision: &self.account_revision,
        }
        .resolve_chatgpt(rejected)
        .await
        .map_err(|e| e.code)?;
        match auth {
            ProviderAuth::ChatGptPlan { authorization, .. } => Ok(authorization),
            _ => Err("provider_auth_missing"),
        }
    }
    pub async fn chatgpt_catalog(&self, value: &mut Value) -> Result<(), Error> {
        let list = self.chatgpt_models().await?.map(|models| {
            models
                .into_iter()
                .filter(|model| {
                    self.registration_catalog
                        .find_static_model_metadata(Some(&format!("openai/{}", model.slug)))
                        .is_some()
                })
                .map(|m| m.slug)
                .collect::<Vec<_>>()
        });
        let account = self.chatgpt_account().await?;
        if let Some(providers) = value["providers"].as_array_mut() {
            for provider in providers {
                if provider["id"] == "openai" || provider["provider_id"] == "openai" {
                    provider["chatgpt_plan_models"] = serde_json::json!(list);
                }
            }
        }
        if let Some(models) = value["registered_models"].as_array_mut() {
            for model in models {
                model["availability"] = if model["auth_type"] == "chatgpt_oauth" {
                    match account.status {
                        super::ChatGptAccountStatus::SignedIn => {
                            if list.as_ref().is_some_and(|l| {
                                !l.iter().any(|id| model["model_id"] == id.as_str())
                            }) {
                                "not_in_plan"
                            } else {
                                "ready"
                            }
                        }
                        super::ChatGptAccountStatus::PlanOff => "plan_off",
                        _ => "sign_in_required",
                    }
                } else {
                    "ready"
                }
                .into();
            }
        }
        Ok(())
    }
}

async fn persist(path: &std::path::Path, cached: &Cached) {
    let Some(parent) = path.parent() else {
        return;
    };
    if tokio::fs::create_dir_all(parent).await.is_err() {
        return;
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(cached) {
        let _ = super::super::auth::io::write_mode_600(path, &bytes).await;
    }
}
