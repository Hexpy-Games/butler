//! Where a scenario's model traffic goes: the live provider, a recording
//! proxy in front of it, or the replay of a committed cassette.

use super::super::agent::Launch;
use super::super::cassette::{Cassette, Meta};
use super::super::config::{Credential, LiveProvider, ModelChoice};
use super::super::fixtures;
use super::super::live;
use super::super::provider::Provider;
use super::super::sanitize::Placeholders;
use super::super::{HarnessError, harness_error};
use super::SANITIZATION;

/// A provider source plus the credential the agent runs with.
type SourceSetup = (Option<Provider>, ModelChoice, Option<(String, Credential)>);

pub(super) fn fixture_app_now(env: &[(String, String)]) -> String {
    env.iter()
        .rev()
        .find(|(key, _)| key == "BUTLER_E2E_APP_NOW")
        .map(|(_, value)| value.clone())
        .unwrap_or_else(|| fixtures::FIXTURE_TIME.to_owned())
}

/// Live mode: the agent talks to the real provider directly.
pub(super) fn live_source(
    live_provider: &LiveProvider,
    model: Option<ModelChoice>,
    launch: &mut Launch,
) -> SourceSetup {
    if let Some(base) = &live_provider.base_url
        && let Some(key) = live_provider.base_url_env()
    {
        launch.set_env(key, base.clone());
    }
    let choice = model.unwrap_or_else(|| live_provider.choice.clone());
    let credential = live_provider
        .credential
        .clone()
        .map(|c| (live_provider.provider.clone(), c));
    (None, choice, credential)
}

/// Replay mode: cassette `name` served by the local provider. With
/// `stub_codex_home`, a subscription cassette gets the placeholder Codex
/// credential there.
pub(super) async fn replay_source(
    name: &str,
    placeholders: &Placeholders,
    stub_codex_home: Option<std::path::PathBuf>,
    launch: &mut Launch,
) -> Result<SourceSetup, HarnessError> {
    replay_loaded_cassette(Cassette::load(name)?, placeholders, stub_codex_home, launch).await
}

/// Replays an in-memory test stub through the same local provider as a cassette.
pub(super) async fn stub_source(
    cassette: Cassette,
    placeholders: &Placeholders,
    stub_codex_home: Option<std::path::PathBuf>,
    launch: &mut Launch,
) -> Result<SourceSetup, HarnessError> {
    replay_loaded_cassette(cassette, placeholders, stub_codex_home, launch).await
}

async fn replay_loaded_cassette(
    cassette: Cassette,
    placeholders: &Placeholders,
    stub_codex_home: Option<std::path::PathBuf>,
    launch: &mut Launch,
) -> Result<SourceSetup, HarnessError> {
    let choice = ModelChoice {
        model: cassette.meta.model.clone(),
        effort: cassette.meta.effort.clone(),
    };
    let provider_name = cassette.meta.provider.clone();
    let provider = Provider::replay(cassette, placeholders.clone()).await?;
    if let Some(key) = super::super::config::base_url_env(&provider_name) {
        let path = super::super::config::base_path(&provider_name);
        launch.set_env(key, format!("{}{path}", provider.base_url));
    }
    if provider_name == "openai-subscription"
        && let Some(codex_home) = stub_codex_home
    {
        fixtures::stub_codex_auth(&codex_home)?;
    }
    Ok((Some(provider), choice, None))
}

/// Record mode: a proxy that forwards cassette `name` to the live provider
/// and records it (`BUTLER_E2E_RECORD=1` or [`super::Setup::record_into`]).
/// With `extends`, requests the base cassette has a recording for are
/// replayed from it and only the new ones are recorded.
pub(super) async fn record_source(
    name: &str,
    model: Option<ModelChoice>,
    placeholders: &Placeholders,
    record_into: Option<std::path::PathBuf>,
    extends: Option<String>,
    launch: &mut Launch,
) -> Result<SourceSetup, HarnessError> {
    let live_provider = live::gate(&format!("record {name}"))?.ok_or_else(|| {
        harness_error("BUTLER_E2E_RECORD=1 needs BUTLER_E2E_TIER=live|all and credentials")
    })?;
    let choice = model.unwrap_or_else(|| live_provider.choice.clone());
    let upstream = live_provider
        .base_url
        .clone()
        .or_else(|| live_provider.upstream_default().map(str::to_owned))
        .ok_or_else(|| harness_error("record mode: no upstream for provider"))?;
    let meta = Meta {
        scenario: name.to_owned(),
        provider: live_provider.provider.clone(),
        model: choice.model.clone(),
        effort: choice.effort.clone(),
        wire_shape: wire_shape(&live_provider.provider).into(),
        butler_git_sha: git_sha(),
        recorded_at: now_utc(),
        recorder: "butler-e2e record proxy".into(),
        sanitization: SANITIZATION.iter().map(|s| (*s).to_owned()).collect(),
        base: extends.clone(),
        ..Meta::default()
    };
    let base = extends.as_deref().map(Cassette::load).transpose()?;
    let provider =
        Provider::record(upstream, meta, placeholders.clone(), record_into, base).await?;
    if let Some(key) = live_provider.base_url_env() {
        let path = super::super::config::base_path(&live_provider.provider);
        launch.set_env(key, format!("{}{path}", provider.base_url));
    }
    let credential = live_provider
        .credential
        .clone()
        .map(|c| (live_provider.provider.clone(), c));
    Ok((Some(provider), choice, credential))
}

/// Points the agent at `credential` through the product's own variables.
/// Another provider's API key never becomes `OPENAI_API_KEY`, whatever
/// model the scenario selects.
pub(super) fn apply_credential(
    launch: &mut Launch,
    provider: &str,
    credential: &Credential,
    choice: &ModelChoice,
) {
    match credential {
        Credential::CodexProfile(path) => {
            launch.set_env("BUTLER_CODEX_AUTH_PROFILE", path.display().to_string());
        }
        Credential::CodexAuthJson(path) => {
            launch.set_env("CODEX_AUTH_JSON", path.display().to_string());
        }
        Credential::ApiKey { env_var } => {
            if provider == "openai"
                && choice.provider() == "openai"
                && let Some(value) = super::super::config::nonempty(env_var)
            {
                launch.set_env("OPENAI_API_KEY", value);
            }
        }
    }
}

fn wire_shape(provider: &str) -> &'static str {
    match provider {
        "openai-subscription" | "openai" => "openai_responses",
        "anthropic" => "anthropic_messages",
        "google" => "gemini_generate_content",
        _ => "openai_chat_completions",
    }
}

fn git_sha() -> String {
    std::process::Command::new("git")
        .args(["rev-parse", "--short=12", "HEAD"])
        .current_dir(crate::e2e::binary::crate_root())
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .unwrap_or_default()
}

fn now_utc() -> String {
    std::process::Command::new("date")
        .args(["-u", "+%Y-%m-%dT%H:%M:%SZ"])
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .unwrap_or_default()
}

/// The refresh token of the placeholder login [`route_login_refresh`] gives
/// a replayed scenario.
pub const STUB_REFRESH_TOKEN: &str = "e2e-replay-refresh";

/// The agent refreshes its Codex login through the provider:
/// `BUTLER_CODEX_OAUTH_TOKEN_URL` names `<provider>/oauth/token`, which the
/// recorder forwards to `auth.openai.com`. A replayed scenario runs with a
/// refreshable placeholder Butler login (`<sandbox>/codex-profile.json`, not
/// expiring) instead of the read-only Codex CLI file; a recording uses the
/// live credential, refreshed in place.
pub(super) fn route_login_refresh(
    launch: &mut Launch,
    provider: &Provider,
    sandbox: &super::super::sandbox::Sandbox,
) -> Result<(), HarnessError> {
    launch.set_env(
        "BUTLER_CODEX_OAUTH_TOKEN_URL",
        format!("{}/oauth/token", provider.base_url),
    );
    if provider.is_recording() {
        return Ok(());
    }
    let profile = sandbox.root.join("codex-profile.json");
    std::fs::write(
        &profile,
        serde_json::json!({
            "provider": "openai-codex",
            "type": "oauth",
            "accessToken": "e2e-replay-placeholder",
            "refreshToken": STUB_REFRESH_TOKEN,
            "expiresAt": 0,
        })
        .to_string(),
    )?;
    launch.set_env("BUTLER_CODEX_AUTH_PROFILE", profile.display().to_string());
    Ok(())
}
