use std::{collections::HashMap, path::Path};

use serde_json::json;
use sha2::{Digest, Sha256};

use super::super::{ModelConfiguration, read_object_sync};
use super::LocalModelMutation;
use crate::models::{LocalModelConfig, ModelCatalogError, normalize_local_model_config};

impl ModelConfiguration {
    pub async fn upsert_local_model(
        &self,
        input: &LocalModelMutation,
        root: Option<&Path>,
    ) -> Result<LocalModelConfig, ModelCatalogError> {
        self.save_local_model(None, input, root)
            .await
            .map(|(model, _)| model)
    }

    pub async fn update_local_model(
        &self,
        lookup: &str,
        input: &LocalModelMutation,
        root: Option<&Path>,
    ) -> Result<(LocalModelConfig, String), ModelCatalogError> {
        self.save_local_model(Some(lookup), input, root).await
    }

    async fn save_local_model(
        &self,
        lookup: Option<&str>,
        input: &LocalModelMutation,
        root: Option<&Path>,
    ) -> Result<(LocalModelConfig, String), ModelCatalogError> {
        let root = root.unwrap_or(&self.data_root);
        let image_discovery = self.probe_local_input(lookup, input, root).await?;
        let _write = self.configuration_writes.acquire().await;
        let _change = super::lock_config(root).await?;
        let mut config = super::super::read_object(&root.join("butler.config.json")).await;
        let current = self.local_models(&config);
        let mut credentials =
            super::super::local_credentials::read(&root.join("auth/custom-model-credentials.json"))
                .await?;
        let (_, api_base_url) = super::super::discovery::normalize_server(&input.server_url)?;
        let model_id = butler_core::public_text::trim_js_whitespace(&input.model_id);
        let previous = if let Some(lookup) = lookup {
            Some(
                find_local(&current, lookup)
                    .ok_or_else(|| super::error("Local model is not registered."))?,
            )
        } else {
            current
                .iter()
                .find(|model| model.model_id == model_id && model.api_base_url == api_base_url)
        };
        let mut candidate = normalize_local_input(input, previous, &self.clock.now_iso())?;
        assign_reference(&mut candidate, previous, &current)?;
        let secret = match input.api_key.as_deref() {
            Some(key) => local_secret(Some(key))?,
            None => previous
                .filter(|model| model.api_base_url == candidate.api_base_url)
                .and_then(|model| credentials.get(&model.model_ref))
                .cloned(),
        };
        candidate.image_discovery = image_discovery.or_else(|| {
            previous
                .filter(|model| {
                    model.api_base_url == candidate.api_base_url
                        && model.model_id == candidate.model_id
                        && model.platform == candidate.platform
                })
                .and_then(|model| model.image_discovery.clone())
        });
        let previous_ref = previous
            .map(|model| model.model_ref.clone())
            .unwrap_or_default();
        let mut next = current
            .into_iter()
            .filter(|model| {
                model.model_ref != previous_ref && model.model_ref != candidate.model_ref
            })
            .collect::<Vec<_>>();
        credentials.remove(&previous_ref);
        next.push(candidate.clone());
        credentials =
            credentials_for_models(&next, &credentials, &candidate.model_ref, secret.as_ref());
        super::set_models_array(
            &mut config,
            "local",
            serde_json::to_value(next).map_err(super::json_error)?,
        );
        persist(root.to_owned(), config, credentials).await?;
        Ok((candidate, previous_ref))
    }

    async fn probe_local_input(
        &self,
        lookup: Option<&str>,
        input: &LocalModelMutation,
        root: &Path,
    ) -> Result<Option<crate::models::LocalImageDiscovery>, ModelCatalogError> {
        let config = super::super::read_object(&root.join("butler.config.json")).await;
        let current = self.local_models(&config);
        let credentials =
            super::super::local_credentials::read(&root.join("auth/custom-model-credentials.json"))
                .await?;
        let (_, api_base_url) = super::super::discovery::normalize_server(&input.server_url)?;
        let model_id = butler_core::public_text::trim_js_whitespace(&input.model_id);
        let previous = if let Some(lookup) = lookup {
            Some(
                find_local(&current, lookup)
                    .ok_or_else(|| super::error("Local model is not registered."))?,
            )
        } else {
            current
                .iter()
                .find(|model| model.model_id == model_id && model.api_base_url == api_base_url)
        };
        let mut candidate = normalize_local_input(input, previous, &self.clock.now_iso())?;
        assign_reference(&mut candidate, previous, &current)?;
        let secret = match input.api_key.as_deref() {
            Some(key) => local_secret(Some(key))?,
            None => previous
                .filter(|model| model.api_base_url == candidate.api_base_url)
                .and_then(|model| credentials.get(&model.model_ref))
                .cloned(),
        };
        Ok(super::super::discovery::image::probe(
            &self.client,
            &candidate.api_base_url,
            &candidate.model_id,
            candidate.platform,
            secret.as_deref(),
        )
        .await)
    }

    pub async fn delete_local_model(
        &self,
        lookup: &str,
        root: Option<&Path>,
    ) -> Result<LocalModelConfig, ModelCatalogError> {
        let _write = self.configuration_writes.acquire().await;
        let root = root.unwrap_or(&self.data_root);
        let _change = super::lock_config(root).await?;
        let mut config = read_object_sync(&root.join("butler.config.json"));
        let current = self.local_models(&config);
        let mut credentials = super::super::local_credentials::read_sync(
            &root.join("auth/custom-model-credentials.json"),
        )?;
        let previous = find_local(&current, lookup)
            .cloned()
            .ok_or_else(|| super::error("Local model is not registered."))?;
        let next = current
            .into_iter()
            .filter(|model| model.model_ref != previous.model_ref)
            .collect::<Vec<_>>();
        credentials = credentials_for_models(&next, &credentials, "", None);
        super::set_models_array(
            &mut config,
            "local",
            serde_json::to_value(next).map_err(super::json_error)?,
        );
        super::super::local_credentials::write(
            &root.join("auth/custom-model-credentials.json"),
            &credentials,
        )?;
        super::write_json(&root.join("butler.config.json"), &config)?;
        Ok(previous)
    }
}

fn normalize_local_input(
    input: &LocalModelMutation,
    previous: Option<&LocalModelConfig>,
    now: &str,
) -> Result<LocalModelConfig, ModelCatalogError> {
    let model_id = butler_core::public_text::trim_js_whitespace(&input.model_id);
    let raw = json!({
        "model_id":input.model_id,
        "model_ref":previous.filter(|model| model.model_id == model_id).map(|model| &model.model_ref),
        "server_url":input.server_url,
        "platform":input.platform,
        "display_name":input.display_name,
        "context_window_tokens":input.context_window_tokens,
        "max_output_tokens":input.max_output_tokens,
        "reasoning_budget_ratio":input.reasoning_budget_ratio,
        "image_input":input.image_input.unwrap_or_else(|| previous.and_then(|model| model.image_input)),
        "response_timeout_ms":input.response_timeout_ms
            .unwrap_or_else(|| previous.and_then(|model| model.response_timeout_ms)),
        "source":input.source,
        "created_at":previous.map(|value| &value.created_at),
        "updated_at":now
    });
    normalize_local_model_config(&raw, now)
        .ok_or_else(|| super::error("Local model configuration is invalid."))
}

fn find_local<'a>(models: &'a [LocalModelConfig], lookup: &str) -> Option<&'a LocalModelConfig> {
    let lookup = butler_core::public_text::trim_js_whitespace(lookup);
    if let Some(exact) = models.iter().find(|model| model.model_ref == lookup) {
        return Some(exact);
    }
    let id = safe_local_id(lookup);
    models.iter().find(|model| {
        model.model_id == lookup || model.model_id == id || model.model_ref == format!("local/{id}")
    })
}

fn local_secret(api_key: Option<&str>) -> Result<Option<String>, ModelCatalogError> {
    let Some(api_key) = api_key else {
        return Ok(None);
    };
    if api_key
        .chars()
        .any(|character| matches!(character, '\r' | '\n'))
    {
        return Err(super::error("Local model API key is invalid."));
    }
    let secret = butler_core::public_text::trim_js_whitespace(api_key);
    Ok((!secret.is_empty()).then(|| secret.to_owned()))
}

fn credentials_for_models(
    models: &[LocalModelConfig],
    current: &HashMap<String, String>,
    updated_ref: &str,
    updated_secret: Option<&String>,
) -> HashMap<String, String> {
    models
        .iter()
        .filter_map(|model| {
            let secret = if model.model_ref == updated_ref {
                updated_secret
            } else {
                current.get(&model.model_ref)
            }?;
            (!secret.is_empty()).then(|| (model.model_ref.clone(), secret.clone()))
        })
        .collect()
}

fn safe_local_id(value: &str) -> String {
    let value = butler_core::public_text::trim_js_whitespace(value)
        .strip_prefix("local/")
        .unwrap_or(value);
    let mut output = String::new();
    let mut separator = false;
    for character in value.chars().filter(|value| !value.is_control()) {
        if character == '/' || character == '\\' || is_js_space(character) {
            if !separator {
                output.push('-');
                separator = true;
            }
        } else {
            output.push(character);
            separator = false;
        }
    }
    let output = output.trim_matches('/').to_owned();
    if output.is_empty() {
        "local-model".into()
    } else {
        output
    }
}

fn is_js_space(value: char) -> bool {
    matches!(value, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}'
        | '\u{3000}' | '\u{feff}')
}

fn assign_reference(
    candidate: &mut LocalModelConfig,
    previous: Option<&LocalModelConfig>,
    current: &[LocalModelConfig],
) -> Result<(), ModelCatalogError> {
    let collision = current.iter().any(|model| {
        model.model_ref == candidate.model_ref
            && previous.is_none_or(|previous| previous.model_ref != model.model_ref)
    });
    if !collision {
        return Ok(());
    }
    if previous.is_some() {
        return Err(super::error(
            "A Custom model with this reference is already registered.",
        ));
    }
    let suffix = format!(
        "{:x}",
        Sha256::digest(format!("{}\n{}", candidate.api_base_url, candidate.model_id).as_bytes())
    );
    candidate.model_ref = format!("{}-{}", candidate.model_ref, &suffix[..12]);
    Ok(())
}

async fn persist(
    root: std::path::PathBuf,
    config: serde_json::Value,
    credentials: HashMap<String, String>,
) -> Result<(), ModelCatalogError> {
    tokio::task::spawn_blocking(move || {
        super::super::local_credentials::write(
            &root.join("auth/custom-model-credentials.json"),
            &credentials,
        )?;
        super::write_json(&root.join("butler.config.json"), &config)
    })
    .await
    .map_err(|source| ModelCatalogError::Storage {
        message: "Local model configuration write task failed.",
        source: source.into(),
    })?
}
