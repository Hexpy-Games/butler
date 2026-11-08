//! `app/setupConnection.ts`: register the chosen model, then make it the default and record
//! the onboarding in one settings PATCH. Everything here is owned and `Send`, so it runs on
//! the agent worker.
use butler_shell_client::{Error, ShellClient};
use gpui::SharedString;
use serde_json::{Map, Value, json};

use super::PendingConnection;
use crate::ui::onboarding::gate::consent_accepted_patch;

const DEFAULT_LOCAL_CONTEXT_TOKENS: u64 = 16_384;
/// `EVERYDAY_EFFORTS`: never xhigh or max.
const EVERYDAY_EFFORTS: [&str; 4] = ["medium", "low", "high", "none"];

pub(super) struct Hosted {
    provider_id: &'static str,
    auth_type: &'static str,
    credential_id: Option<String>,
    keep_defaults: bool,
}

/// What to register.
pub(super) enum Registration {
    Local { body: Value },
    Hosted(Hosted),
}

impl Registration {
    pub(super) fn new(connection: &PendingConnection) -> Self {
        match connection {
            &PendingConnection::Hosted {
                provider_id,
                auth_type,
                ref credential_id,
                keep_defaults,
                ..
            } => Self::Hosted(Hosted {
                provider_id,
                auth_type,
                credential_id: credential_id.as_ref().map(ToString::to_string),
                keep_defaults,
            }),
            PendingConnection::Local {
                option, api_key, ..
            } => {
                let source = option.source_model.as_deref();
                let model_id: &str = &option.model_id;
                let display_name = source
                    .and_then(|model| model.get("display_name"))
                    .and_then(Value::as_str)
                    .unwrap_or(model_id);
                let context = option
                    .context_window_tokens
                    .filter(|tokens| *tokens > 0)
                    .unwrap_or(DEFAULT_LOCAL_CONTEXT_TOKENS);
                let mut body = json!({
                    "provider_id": "local",
                    "api_type": "openai_compatible",
                    "platform": &*option.platform,
                    "server_url": &*option.server_url,
                    "model_id": model_id,
                    "display_name": display_name,
                    "context_window_tokens": context,
                    "source": "discovered",
                });
                if let Some(max) = source
                    .and_then(|model| model.get("max_output_tokens"))
                    .filter(|value| !value.is_null())
                {
                    body["max_output_tokens"] = max.clone();
                }
                if let Some(key) = api_key
                    .as_ref()
                    .filter(|key: &&SharedString| !key.is_empty())
                {
                    body["api_key"] = Value::from(key.to_string());
                }
                Self::Local { body }
            }
        }
    }
}

struct Registered {
    model: Value,
    effort: String,
    catalog: Value,
}

struct Preset {
    model: Value,
    effort: String,
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn models(provider: &Value) -> &[Value] {
    provider
        .get("models")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn field(result: &Value, key: &str) -> Result<Value, Error> {
    result.get(key).cloned().ok_or(Error::Protocol)
}

/// `routinePreset`: the provider's everyday default model, never xhigh or max.
fn routine_preset(catalog: &Value, provider_id: &str) -> Option<Preset> {
    let provider = find_provider(catalog, provider_id)?;
    let find = |reference: &str| {
        models(provider).iter().find(|model| {
            text(model, "model_ref") == reference || text(model, "model_id") == reference
        })
    };
    let worker = catalog
        .get("worker_model_presets")
        .and_then(Value::as_array)
        .and_then(|presets| {
            presets
                .iter()
                .find(|p| text(p, "provider_id") == provider_id)
        })
        .and_then(|preset| preset.get("routine_work"));
    let listed = provider.get("presets").and_then(|p| p.get("routine"));
    for (preset, effort_key) in [(listed, "effort"), (worker, "reasoning_effort")] {
        let Some(preset) = preset else { continue };
        if let Some(model) = find(text(preset, "model")) {
            return Some(Preset {
                model: model.clone(),
                effort: text(preset, effort_key).to_owned(),
            });
        }
    }
    let model = models(provider)
        .iter()
        .find(|model| text(model, "tier") == "balanced")
        .or_else(|| {
            models(provider)
                .iter()
                .find(|model| text(model, "status") == "recommended")
        })
        .or_else(|| find(text(provider, "latest_model_ref")))
        .or_else(|| models(provider).first())?;
    let efforts = model.get("reasoning_efforts").and_then(Value::as_array);
    let effort = EVERYDAY_EFFORTS
        .iter()
        .find(|effort| efforts.is_some_and(|all| all.iter().any(|e| e.as_str() == Some(**effort))))
        .unwrap_or(&"medium");
    Some(Preset {
        model: model.clone(),
        effort: (*effort).to_owned(),
    })
}

fn find_provider<'a>(catalog: &'a Value, provider_id: &str) -> Option<&'a Value> {
    catalog
        .get("providers")
        .and_then(Value::as_array)?
        .iter()
        .find(|provider| text(provider, "provider_id") == provider_id)
}

/// The ChatGPT plan's first model, when the preset is not one the plan covers.
fn plan_preset(
    provider: Option<&Value>,
    auth_type: &str,
    preset: Option<&Preset>,
) -> Option<Preset> {
    let provider = provider.filter(|_| auth_type == "chatgpt_oauth")?;
    let plan = provider
        .get("chatgpt_plan_models")
        .and_then(Value::as_array)
        .filter(|plan| !plan.is_empty())?;
    if preset.is_some_and(|p| {
        plan.iter()
            .any(|id| id.as_str() == Some(text(&p.model, "model_id")))
    }) {
        return None;
    }
    let first = plan.first()?.as_str()?;
    let model = models(provider)
        .iter()
        .find(|model| text(model, "model_id") == first)?;
    Some(Preset {
        model: model.clone(),
        effort: text(model, "default_reasoning_effort").to_owned(),
    })
}

async fn register_hosted(
    client: &ShellClient,
    hosted: Hosted,
    settings: &Value,
) -> Result<Registered, Error> {
    let catalog = client.get_model_catalog().await?;
    let provider = find_provider(&catalog, hosted.provider_id);
    let in_use = provider.filter(|_| hosted.keep_defaults).and_then(|p| {
        models(p)
            .iter()
            .find(|m| text(m, "model_ref") == text(settings, "model"))
    });
    let mut preset = match in_use {
        Some(model) => Some(Preset {
            model: model.clone(),
            effort: text(settings, "reasoning_effort").to_owned(),
        }),
        None => routine_preset(&catalog, hosted.provider_id),
    };
    if let Some(plan) = plan_preset(provider, hosted.auth_type, preset.as_ref()) {
        preset = Some(plan);
    }
    // `no_usable_model`
    let preset = preset.ok_or(Error::Protocol)?;
    let mut body = json!({
        "provider_id": hosted.provider_id,
        "model_id": text(&preset.model, "model_id"),
        "auth_type": hosted.auth_type,
    });
    if let Some(id) = hosted.credential_id {
        body["credential_id"] = Value::from(id);
    }
    let result = client.register_hosted_model(&body).await?;
    Ok(Registered {
        model: field(&result, "model")?,
        effort: preset.effort,
        catalog: field(&result, "catalog")?,
    })
}

async fn register(
    client: &ShellClient,
    registration: Registration,
    settings: &Value,
) -> Result<Registered, Error> {
    match registration {
        Registration::Hosted(hosted) => register_hosted(client, hosted, settings).await,
        Registration::Local { body } => {
            let result = client.register_local_model(&body).await?;
            let model = field(&result, "model")?;
            Ok(Registered {
                effort: text(&model, "default_reasoning_effort").to_owned(),
                model,
                catalog: field(&result, "catalog")?,
            })
        }
    }
}

/// `defaultModelSettingsPatch`: chat model, effort and every Worker profile on the model.
fn default_model_patch(
    settings: &Value,
    model: &Value,
    effort: &str,
    label: &str,
) -> Map<String, Value> {
    let reference = model.get("model_ref").cloned().unwrap_or(Value::Null);
    let profiles = settings
        .get("worker_profiles")
        .and_then(Value::as_array)
        .filter(|profiles| !profiles.is_empty())
        .cloned()
        .unwrap_or_else(|| {
            vec![json!({
                "id": "default", "label": label, "enabled": true,
                "job": {"kind": "builtin", "job": "coding"},
                "model": reference, "reasoning_effort": effort,
            })]
        });
    let profiles: Vec<Value> = profiles
        .into_iter()
        .map(|mut profile| {
            if let Some(profile) = profile.as_object_mut() {
                profile.insert("model".into(), reference.clone());
                profile.insert("reasoning_effort".into(), effort.into());
            }
            profile
        })
        .collect();
    let mut patch = Map::new();
    patch.insert("model".into(), reference);
    patch.insert("reasoning_effort".into(), effort.into());
    let context = model
        .get("context_window_tokens")
        .filter(|value| !value.is_null())
        .or_else(|| settings.get("context_window_tokens"));
    if let Some(context) = context {
        patch.insert("context_window_tokens".into(), context.clone());
    }
    patch.insert("worker_profiles".into(), Value::Array(profiles));
    patch
}

/// `commitConnection`: `{settings, catalog}` after the registration and the settings PATCH.
pub(super) async fn commit_connection(
    client: ShellClient,
    registration: Registration,
    language: &'static str,
    accepted_at: String,
    profile_label: &'static str,
) -> Result<Value, Error> {
    let settings = client.get_settings().await?;
    let keep_defaults = matches!(&registration, Registration::Hosted(h) if h.keep_defaults);
    let registered = register(&client, registration, &settings).await?;
    let mut patch = Map::new();
    patch.insert("language".into(), language.into());
    if !keep_defaults {
        patch.extend(default_model_patch(
            &settings,
            &registered.model,
            &registered.effort,
            profile_label,
        ));
    }
    // An agent before #230 has no `onboarding` setting and rejects unknown fields.
    if let Some(onboarding) = settings.get("onboarding").filter(|value| !value.is_null())
        && let Value::Object(onboarding) = consent_accepted_patch(onboarding, &accepted_at)
    {
        patch.extend(onboarding);
    }
    let saved = client
        .update_settings(&Value::Object(patch.clone()))
        .await?;
    let mut merged = settings.as_object().cloned().unwrap_or_default();
    merged.extend(patch);
    if let Value::Object(saved) = saved {
        merged.extend(saved);
    }
    merged.insert("language".into(), language.into());
    Ok(json!({"settings": merged, "catalog": registered.catalog}))
}
