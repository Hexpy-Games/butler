//! Where a scenario's model traffic goes: the live provider, a recording
//! proxy in front of it, or the replay of a committed cassette.

use super::super::agent::Launch;
use super::super::cassette::{Cassette, Meta};
use super::super::config::{Credential, LiveProvider, ModelChoice, base_url_env, nonempty};
use super::super::live;
use super::super::provider::Provider;
use super::super::sanitize::Placeholders;
use super::super::{HarnessError, harness_error};

type Source = (Option<Provider>, ModelChoice, Option<(String, Credential)>);

/// Live mode: the agent talks to the provider directly.
pub(super) fn live_source(
    live_provider: &LiveProvider,
    model: Option<ModelChoice>,
    launch: &mut Launch,
) -> Source {
    if let Some(base) = &live_provider.base_url
        && let Some(key) = live_provider.base_url_env()
    {
        launch.set_env(key, base.clone());
    }
    let choice = model.unwrap_or_else(|| live_provider.choice.clone());
    let credential = live_provider
        .credential
        .clone()
        .map(|credential| (live_provider.provider.clone(), credential));
    (None, choice, credential)
}

/// Record mode: a recording proxy in front of the live provider (replaying
/// what the `extends` base cassette already holds).
pub(super) async fn record_provider(
    name: &str,
    model: Option<ModelChoice>,
    record_into: Option<std::path::PathBuf>,
    extends: Option<String>,
    placeholders: &Placeholders,
    launch: &mut Launch,
) -> Result<Source, HarnessError> {
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
        sanitization: super::SANITIZATION
            .iter()
            .map(|s| (*s).to_owned())
            .collect(),
        base: extends.clone(),
        ..Meta::default()
    };
    let base = extends.as_deref().map(Cassette::load).transpose()?;
    let provider =
        Provider::record(upstream, meta, placeholders.clone(), record_into, base).await?;
    if let Some(key) = live_provider.base_url_env() {
        launch.set_env(key, provider.base_url.clone());
    }
    let credential = live_provider
        .credential
        .clone()
        .map(|c| (live_provider.provider.clone(), c));
    Ok((Some(provider), choice, credential))
}

/// Replay mode: serves the committed cassette `name` to the agent. Also says
/// whether it was recorded against the ChatGPT subscription (replay then
/// needs a placeholder Codex credential to select that mode).
pub(super) async fn replay_provider(
    name: &str,
    placeholders: &Placeholders,
    launch: &mut Launch,
) -> Result<(Provider, ModelChoice, bool), HarnessError> {
    let cassette = Cassette::load(name)?;
    let choice = ModelChoice {
        model: cassette.meta.model.clone(),
        effort: cassette.meta.effort.clone(),
    };
    let provider_name = cassette.meta.provider.clone();
    let provider = Provider::replay(cassette, placeholders.clone()).await?;
    if let Some(key) = base_url_env(&provider_name) {
        launch.set_env(key, provider.base_url.clone());
    }
    Ok((provider, choice, provider_name == "openai-subscription"))
}

/// Hands a live credential to the agent by path or through the product's
/// own environment variable; the harness never reads token values.
pub(super) fn apply_credential(launch: &mut Launch, credential: &Credential, choice: &ModelChoice) {
    match credential {
        Credential::CodexProfile(path) => {
            launch.set_env("BUTLER_CODEX_AUTH_PROFILE", path.display().to_string());
        }
        Credential::CodexAuthJson(path) => {
            launch.set_env("CODEX_AUTH_JSON", path.display().to_string());
        }
        Credential::ApiKey { env_var } => {
            if choice.provider() == "openai"
                && let Some(value) = nonempty(env_var)
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
        .current_dir(env!("CARGO_MANIFEST_DIR"))
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
