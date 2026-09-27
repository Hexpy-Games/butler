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
