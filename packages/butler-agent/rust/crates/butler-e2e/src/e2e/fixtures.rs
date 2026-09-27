//! Data-dir fixtures (SCENARIOS.md §0.3).
//!
//! `F1-ready` is the state a first-run App leaves after onboarding: the
//! onboarding record marked complete and a config selecting a model. The
//! reasoning effort is then set through `PATCH /settings`, as the App does.

use std::fs;
use std::path::Path;

use serde_json::json;

use super::HarnessError;
use super::sandbox::copy_tree;

pub const FIXTURE_TIME: &str = "2026-09-27T00:00:00Z";

/// `F1-ready`: onboarding complete, `model` as the default, language `en`.
pub fn ready(data: &Path, model: &str) -> Result<(), HarnessError> {
    onboarding_complete(data)?;
    scheduler_ran_today(data)?;
    fs::write(
        data.join("butler.config.json"),
        serde_json::to_vec_pretty(&json!({
            "user": {"name": "E2E", "language": "en"},
            "system": {"defaultModel": model},
            "metrics": {"enabled": false}
        }))?,
    )?;
    Ok(())
}

/// Marks the two daily 04:00 jobs (session sync, consolidation cycle) as
/// already run today (UTC; the harness runs the agent with `TZ=UTC`), as on
/// an installation that has been running. Otherwise the consolidation cycle
/// starts a background briefing model call whose prompt embeds the current
/// time, which no recording can match.
pub fn scheduler_ran_today(data: &Path) -> Result<(), HarnessError> {
    let dir = data.join("state/scheduler");
    fs::create_dir_all(&dir)?;
    let now = chrono::Utc::now();
    let day = now.format("%Y-%m-%d").to_string();
    for id in ["session-sync", "consolidation-cycle"] {
        fs::write(
            dir.join(format!("{id}.json")),
            json!({"lastRunDate": day, "lastRunAt": now.to_rfc3339(), "status": "ok"}).to_string(),
        )?;
    }
    Ok(())
}

pub fn onboarding_complete(data: &Path) -> Result<(), HarnessError> {
    fs::create_dir_all(data.join("personalization"))?;
    fs::write(
        data.join("personalization/onboarding.json"),
        json!({
            "schema": "butler.first_chat_onboarding.v1",
            "status": "complete",
            "gateway": "any",
            "fields": {},
            "skipped_fields": [],
            "created_at": FIXTURE_TIME,
            "updated_at": FIXTURE_TIME,
            "completed_at": FIXTURE_TIME
        })
        .to_string(),
    )?;
    Ok(())
}

/// Copies a committed fixture tree (`crates/butler-e2e/fixtures/<name>`) into `data`.
pub fn install_tree(name: &str, data: &Path) -> Result<(), HarnessError> {
    let source = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join(name);
    copy_tree(&source, data)
}

/// Fake Codex CLI auth file for replay: the stub accepts any bearer, and the
/// product needs a credential to select subscription mode. No real token.
pub fn stub_codex_auth(codex_home: &Path) -> Result<(), HarnessError> {
    fs::create_dir_all(codex_home)?;
    fs::write(
        codex_home.join("auth.json"),
        json!({"tokens": {"access_token": "e2e-replay-placeholder"}}).to_string(),
    )?;
    Ok(())
}

/// `F3-legacy`: a synthetic previous-generation data dir (see
/// `fixtures/F3-legacy`): the legacy App DB built from `app-server.sql`,
/// an unknown legacy file, onboarding and a model config.
pub fn legacy(data: &Path, model: &str) -> Result<(), HarnessError> {
    ready(data, model)?;
    install_tree("F3-legacy/data", data)?;
    let sql = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/F3-legacy/app-server.sql"),
    )?;
    fs::create_dir_all(data.join("app-server"))?;
    let connection = rusqlite::Connection::open(data.join("app-server/butler-client.sqlite"))
        .map_err(|error| super::harness_error(format!("legacy fixture: {error}")))?;
    connection
        .execute_batch(&sql)
        .map_err(|error| super::harness_error(format!("legacy fixture: {error}")))?;
    Ok(())
}

/// The legacy fixture's expected-content manifest.
pub fn legacy_manifest() -> Result<serde_json::Value, HarnessError> {
    Ok(serde_json::from_slice(&fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/F3-legacy/manifest.json"),
    )?)?)
}

/// Files of the local BGE-M3 embedding model the product loads from
/// `D/cache/models/Xenova/bge-m3` (and otherwise downloads on first use).
pub const EMBEDDING_ASSETS: [&str; 4] = [
    "tokenizer.json",
    "tokenizer_config.json",
    "config.json",
    "onnx/model_quantized.onnx",
];

/// Installs the embedding model from `BUTLER_E2E_EMBEDDING_ASSETS` (a dir
/// holding [`EMBEDDING_ASSETS`]) into the data dir, hard-linked when
/// possible. Returns false when the assets are not available.
pub fn embedding_assets(data: &Path) -> Result<bool, HarnessError> {
    let Some(source) =
        super::config::nonempty("BUTLER_E2E_EMBEDDING_ASSETS").map(std::path::PathBuf::from)
    else {
        return Ok(false);
    };
    if !EMBEDDING_ASSETS
        .iter()
        .all(|asset| source.join(asset).is_file())
    {
        return Ok(false);
    }
    let target = data.join("cache/models/Xenova/bge-m3");
    for asset in EMBEDDING_ASSETS {
        let to = target.join(asset);
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        if fs::hard_link(source.join(asset), &to).is_err() {
            fs::copy(source.join(asset), &to)?;
        }
    }
    Ok(true)
}
