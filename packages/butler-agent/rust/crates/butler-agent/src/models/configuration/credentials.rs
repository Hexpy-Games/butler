use std::path::Path;

use serde_json::{Value, json};

use super::super::catalog::{hosted_provider, normalize_display_label};
use super::super::{CredentialView, ModelCatalogSnapshot, ProviderAuthMethod};
use super::{ModelConfigurationClock, array, first_by_key, text};

pub(super) struct CredentialRecord {
    pub(super) id: String,
    pub(super) provider_id: String,
    pub(super) secret: String,
    label: String,
    created_at: String,
    updated_at: String,
}

impl CredentialRecord {
    pub(super) fn view(&self) -> CredentialView {
        let prefix: String = self
            .secret
            .chars()
            .scan(0, |units, character| {
                *units += character.len_utf16();
                (*units <= 3).then_some(character)
            })
            .collect();
        // Valid scalar suffix; lone-surrogate source masks remain tracked by
        // the migration's JSON/UTF-16 representation obligation.
        let suffix = self
            .secret
            .chars()
            .last()
            .map(|value| value.to_string())
            .unwrap_or_default();
        CredentialView {
            id: self.id.clone(),
            provider_id: self.provider_id.clone(),
            auth_type: ProviderAuthMethod::ApiKey,
            label: self.label.clone(),
            masked_value: format!("{prefix}...{suffix}"),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
        }
    }
}

pub(super) fn read(
    value: &Value,
    catalog: &ModelCatalogSnapshot,
    clock: &dyn ModelConfigurationClock,
) -> Vec<CredentialRecord> {
    first_by_key(
        array(value.get("credentials")).iter().filter_map(|value| {
            let provider_id = hosted_provider(value.get("provider_id")?.as_str()?)?;
            if value.get("auth_type").and_then(Value::as_str) != Some("api_key") {
                return None;
            }
            let secret = text(value.get("secret"))?.to_owned();
            let id = text(value.get("id"))?.to_owned();
            let now = clock.now_iso();
            let provider_label = catalog
                .view()
                .models
                .iter()
                .find(|model| model.provider_id == provider_id)
                .map(|model| model.provider_label.as_str())
                .unwrap_or(&provider_id);
            Some(CredentialRecord {
                id,
                label: normalize_display_label(value.get("label"), provider_label),
                provider_id,
                secret,
                created_at: value
                    .get("created_at")
                    .and_then(Value::as_str)
                    .unwrap_or(&now)
                    .into(),
                updated_at: value
                    .get("updated_at")
                    .and_then(Value::as_str)
                    .unwrap_or(&now)
                    .into(),
            })
        }),
        |record| record.id.clone(),
    )
}

pub(super) fn upsert(
    path: &Path,
    provider_id: &str,
    secret: &str,
    label: Option<&str>,
    credential_id: Option<&str>,
    catalog: &ModelCatalogSnapshot,
    clock: &dyn ModelConfigurationClock,
) -> Result<CredentialView, crate::models::ModelCatalogError> {
    let provider_id = hosted_provider(provider_id)
        .ok_or_else(|| crate::models::ModelCatalogError::rejected("Unsupported provider."))?;
    let secret = crate::public_text::trim_js_whitespace(secret);
    if secret.is_empty() {
        return Err(crate::models::ModelCatalogError::rejected(
            "Provider API key is required.",
        ));
    }
    let file = super::read_object_sync(path);
    let mut records = read(&file, catalog, clock);
    let existing_index = credential_id
        .map(crate::public_text::trim_js_whitespace)
        .filter(|id| !id.is_empty())
        .and_then(|id| records.iter().position(|record| record.id == id));
    let previous = existing_index.map(|index| &records[index]);
    if previous.is_some_and(|record| record.provider_id != provider_id) {
        return Err(crate::models::ModelCatalogError::rejected(
            "Credential provider does not match the selected provider.",
        ));
    }
    let provider_label = catalog
        .view()
        .models
        .iter()
        .find(|model| model.provider_id == provider_id)
        .map(|model| model.provider_label.clone())
        .unwrap_or_else(|| provider_id.clone());
    let now = clock.now_iso();
    let record = CredentialRecord {
        id: previous
            .map(|record| record.id.clone())
            .unwrap_or_else(|| format!("cred_{}", uuid::Uuid::new_v4())),
        provider_id,
        secret: secret.to_owned(),
        label: normalize_display_label(
            label.map(|value| Value::String(value.to_owned())).as_ref(),
            previous
                .map(|record| record.label.as_str())
                .unwrap_or(provider_label.as_str()),
        ),
        created_at: previous
            .map(|record| record.created_at.clone())
            .unwrap_or_else(|| now.clone()),
        updated_at: now,
    };
    let view = record.view();
    if let Some(index) = existing_index {
        records[index] = record;
    } else {
        records.push(record);
    }
    let credentials = records
        .iter()
        .map(|record| {
            json!({
                "id": record.id,
                "provider_id": record.provider_id,
                "auth_type": "api_key",
                "label": record.label,
                "secret": record.secret,
                "created_at": record.created_at,
                "updated_at": record.updated_at,
            })
        })
        .collect::<Vec<_>>();
    super::mutations::write_json(path, &json!({"credentials": credentials}))?;
    Ok(view)
}
