use std::{collections::HashMap, path::Path};

use serde_json::json;
use sha2::{Digest, Sha256};

use super::super::{ModelConfiguration, read_object_sync};
use super::LocalModelMutation;
use crate::models::{LocalModelConfig, ModelCatalogError, normalize_local_model_config};

impl ModelConfiguration {
    pub(crate) async fn upsert_local_model(
        &self,
        input: &LocalModelMutation,
        root: Option<&Path>,
    ) -> Result<LocalModelConfig, ModelCatalogError> {
        let _write = self.configuration_writes.acquire().await;
        let root = root.unwrap_or(&self.data_root);
        let mut config = read_object_sync(&root.join("butler.config.json"));
        let current = self.local_models(&config);
        let mut credentials = super::super::local_credentials::read_sync(
            &root.join("auth/custom-model-credentials.json"),
        )?;
        let now = self.clock.now_iso();
        let (_, api_base_url) = super::super::discovery::normalize_server(&input.server_url)?;
        let model_id = crate::public_text::trim_js_whitespace(&input.model_id);
        let previous = current
            .iter()
            .find(|model| model.model_id == model_id && model.api_base_url == api_base_url);
        let mut candidate = normalize_local_input(input, previous, &now)?;
        if previous.is_none()
            && current
                .iter()
                .any(|model| model.model_ref == candidate.model_ref)
        {
            let suffix = format!(
                "{:x}",
                Sha256::digest(
                    format!("{}\n{}", candidate.api_base_url, candidate.model_id).as_bytes()
                )
            );
            candidate.model_ref = format!("{}-{}", candidate.model_ref, &suffix[..12]);
        }
        let candidate_secret = match input.api_key.as_deref() {
            Some(api_key) => local_secret(Some(api_key))?,
            None => previous
                .and_then(|model| credentials.get(&model.model_ref))
                .cloned(),
        };
        let mut next = current
            .into_iter()
            .filter(|model| model.model_ref != candidate.model_ref)
            .collect::<Vec<_>>();
        next.push(candidate.clone());
        credentials =
            credentials_for_models(&next, &credentials, &candidate.model_ref, candidate_secret);
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
        Ok(candidate)
    }

    pub(crate) async fn update_local_model(
        &self,
        lookup: &str,
        input: &LocalModelMutation,
        root: Option<&Path>,
    ) -> Result<(LocalModelConfig, String), ModelCatalogError> {
        let _write = self.configuration_writes.acquire().await;
        let root = root.unwrap_or(&self.data_root);
        let mut config = read_object_sync(&root.join("butler.config.json"));
        let current = self.local_models(&config);
        let mut credentials = super::super::local_credentials::read_sync(
            &root.join("auth/custom-model-credentials.json"),
        )?;
        let previous = find_local(&current, lookup)
            .cloned()
            .ok_or_else(|| super::error("Local model is not registered."))?;
        let candidate = normalize_local_input(input, Some(&previous), &self.clock.now_iso())?;
        if current.iter().any(|model| {
            model.model_ref == candidate.model_ref && model.model_ref != previous.model_ref
        }) {
            return Err(super::error(
                "A Custom model with this reference is already registered.",
            ));
        }
        let candidate_secret = match input.api_key.as_deref() {
            Some(api_key) => local_secret(Some(api_key))?,
            None if previous.api_base_url == candidate.api_base_url => {
                credentials.get(&previous.model_ref).cloned()
            }
            None => None,
        };
        let mut next = current
            .into_iter()
            .filter(|model| {
                model.model_ref != previous.model_ref && model.model_ref != candidate.model_ref
            })
            .collect::<Vec<_>>();
        let previous_ref = previous.model_ref.clone();
        next.push(candidate.clone());
        credentials.remove(&previous.model_ref);
        credentials =
            credentials_for_models(&next, &credentials, &candidate.model_ref, candidate_secret);
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
        Ok((candidate, previous_ref))
    }

    pub(crate) async fn delete_local_model(
        &self,
        lookup: &str,
        root: Option<&Path>,
    ) -> Result<LocalModelConfig, ModelCatalogError> {
        let _write = self.configuration_writes.acquire().await;
        let root = root.unwrap_or(&self.data_root);
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
    let model_id = crate::public_text::trim_js_whitespace(&input.model_id);
    let raw = json!({
        "model_id":input.model_id,
        "model_ref":previous.filter(|model| model.model_id == model_id).map(|model| &model.model_ref),
        "server_url":input.server_url,
        "platform":input.platform,
        "display_name":input.display_name,
        "context_window_tokens":input.context_window_tokens,
        "max_output_tokens":input.max_output_tokens,
        "reasoning_budget_ratio":input.reasoning_budget_ratio,
        "source":input.source,
        "created_at":previous.map(|value| &value.created_at),
        "updated_at":now
    });
    normalize_local_model_config(&raw, now)
        .ok_or_else(|| super::error("Local model configuration is invalid."))
}

fn find_local<'a>(models: &'a [LocalModelConfig], lookup: &str) -> Option<&'a LocalModelConfig> {
    let lookup = crate::public_text::trim_js_whitespace(lookup);
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
    let secret = crate::public_text::trim_js_whitespace(api_key);
    Ok((!secret.is_empty()).then(|| secret.to_owned()))
}

fn credentials_for_models(
    models: &[LocalModelConfig],
    current: &HashMap<String, String>,
    updated_ref: &str,
    updated_secret: Option<String>,
) -> HashMap<String, String> {
    models
        .iter()
        .filter_map(|model| {
            let secret = if model.model_ref == updated_ref {
                updated_secret.as_ref()
            } else {
                current.get(&model.model_ref)
            }?;
            (!secret.is_empty()).then(|| (model.model_ref.clone(), secret.clone()))
        })
        .collect()
}

fn safe_local_id(value: &str) -> String {
    let value = crate::public_text::trim_js_whitespace(value)
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
