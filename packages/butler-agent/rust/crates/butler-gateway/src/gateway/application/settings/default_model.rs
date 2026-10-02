//! The global model before the user chose one (#230).
//!
//! A new install starts on the routine preset of the connected provider at
//! the preset's effort, never the provider's top model at its highest
//! effort. An install from before this release that never chose a model
//! keeps the default it has been running with (as with the access mode,
//! saved and unsaved settings are not migrated).

use rusqlite::{Connection, params};
use serde_json::{Map, Value};

use super::model::{self, PrimaryModel};
use super::persistence::read_json;
use crate::gateway::application::AppSettingsFacts;
use crate::gateway::application::storage::AppStorageError;
use butler_turn::btcc::ReasoningEffort;

/// The default of an existing install, and when the catalog has no routine
/// preset to offer.
use butler_models::models::LEGACY_DEFAULT_MODEL;

/// The `app_settings` key holding which default an unchosen model resolves
/// to on this install. The App database migration records it once.
const DEFAULT_MODEL_POLICY_KEY: &str = "default-model-policy";
const ROUTINE_PRESET_POLICY: &str = "routine_preset";
const LEGACY_POLICY: &str = "legacy";

/// Records, once, the default an unchosen model resolves to: the legacy
/// default when the App database existed before this release
/// (`existing_database`), the routine preset for a new one.
pub(in crate::gateway::application) fn record_default_model_policy(
    db: &Connection,
    existing_database: bool,
) -> Result<(), AppStorageError> {
    let policy = if existing_database {
        LEGACY_POLICY
    } else {
        ROUTINE_PRESET_POLICY
    };
    db.execute(
        "INSERT OR IGNORE INTO app_settings(key,value_json,updated_at) \
         VALUES(?1,?2,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        params![DEFAULT_MODEL_POLICY_KEY, Value::from(policy).to_string()],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok(())
}

/// Whether an unchosen model resolves to the routine preset here (a
/// database the migration has not seen counts as new).
pub(super) fn uses_routine_preset(db: &Connection) -> Result<bool, AppStorageError> {
    Ok(read_json(db, DEFAULT_MODEL_POLICY_KEY)?
        .as_ref()
        .and_then(Value::as_str)
        != Some(LEGACY_POLICY))
}

/// The global model and effort: the stored choice, else the configured
/// default model, else (`routine`) the routine preset or the legacy
/// default. A stored effort the model does not offer falls back to the
/// model's default effort.
pub(super) fn resolve(
    stored: &Map<String, Value>,
    facts: &AppSettingsFacts,
    routine: bool,
) -> (PrimaryModel, ReasoningEffort) {
    let chosen = stored
        .get("model")
        .and_then(Value::as_str)
        .or(facts.config_default_model.as_deref());
    let (preset_model, preset_effort) = if routine {
        routine_default(facts)
    } else {
        (LEGACY_DEFAULT_MODEL.to_owned(), None)
    };
    let metadata = model::resolve_primary(chosen.unwrap_or(&preset_model), facts);
    let preset_effort =
        preset_effort.filter(|_| chosen.is_none() && metadata.model_ref == preset_model);
    let reasoning = stored
        .get("reasoning_effort")
        .and_then(Value::as_str)
        .and_then(model::parse_reasoning)
        .or(preset_effort)
        .filter(|value| metadata.reasoning_efforts.contains(value))
        .unwrap_or_else(|| metadata.default_reasoning_effort.clone());
    (metadata, reasoning)
}

/// The routine preset of the first connected provider (OpenAI before any
/// is connected) when its model is available, with the preset's effort;
/// else the first connected model, or the legacy default.
fn routine_default(facts: &AppSettingsFacts) -> (String, Option<ReasoningEffort>) {
    let preset = &facts.native_settings["routine_default"];
    if let Some(model) = preset["model"].as_str() {
        return (
            model.to_owned(),
            preset["effort"].as_str().and_then(model::parse_reasoning),
        );
    }
    (
        facts
            .config_default_model
            .clone()
            .unwrap_or_else(|| LEGACY_DEFAULT_MODEL.into()),
        None,
    )
}
