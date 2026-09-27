//! Scenario setup: sandbox + fixture + provider (replay, record or live) +
//! agent process, in one builder.
//!
//! ```text
//! let setup = Setup::new("TURN-01")?.cassette("TURN-01");
//! std::fs::write(setup.sandbox.workspace.join("notes.txt"), &nonce)?;
//! let mut s = setup.start().await?;
//! ```

use std::time::Duration;

use serde_json::{Value, json};

use super::agent::{Agent, Launch};
use super::cassette::{Cassette, Meta};
use super::config::{Credential, LiveProvider, ModelChoice, flag};
use super::fixtures;
use super::gateway::{Gateway, Reply};
use super::live;
use super::provider::Provider;
use super::sandbox::Sandbox;
use super::sanitize::Placeholders;
use super::{HarnessError, harness_error};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fixture {
    /// `F0-empty`.
    Empty,
    /// `F1-ready`.
    Ready,
    /// `F3-legacy` (synthetic previous-generation data dir).
    Legacy,
    /// `F2-first-conversation`: like `F1-ready` with the first-conversation
    /// onboarding not done yet.
    FirstConversation,
}

/// The global access mode a scenario starts with (`PATCH /settings`).
/// Every scenario recorded before ask-first became the default assumes full
/// access, so that stays the harness default.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    FullAccess,
    AskFirst,
}

impl Access {
    /// The settings value.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FullAccess => "full_access",
            Self::AskFirst => "ask_first",
        }
    }
}

enum Source {
    None,
    Cassette(String),
    Live(LiveProvider),
}

pub struct Setup {
    pub id: String,
    pub sandbox: Sandbox,
    pub placeholders: Placeholders,
    fixture: Fixture,
    access: Access,
    source: Source,
    env: Vec<(String, String)>,
    model: Option<ModelChoice>,
    stub_credential: bool,
    record_into: Option<std::path::PathBuf>,
}

/// A running scenario. Field order is drop order: agent before sandbox.
pub struct Scenario {
    pub id: String,
    pub gw: Gateway,
    pub agent: Agent,
    pub provider: Option<Provider>,
    pub model: ModelChoice,
    pub sandbox: Sandbox,
}

impl Setup {
    pub fn new(id: &str) -> Result<Self, HarnessError> {
        let sandbox = Sandbox::new(id)?;
        let mut placeholders = Placeholders::default();
        placeholders.add("W", sandbox.workspace.display().to_string());
        placeholders.add("D", sandbox.data.display().to_string());
        placeholders.add("SANDBOX", sandbox.root.display().to_string());
        Ok(Self {
            id: id.to_owned(),
            sandbox,
            placeholders,
            fixture: Fixture::Ready,
            access: Access::FullAccess,
            source: Source::None,
            env: Vec::new(),
            model: None,
            stub_credential: true,
            record_into: None,
        })
    }

    /// Replays (or with `BUTLER_E2E_RECORD=1`, records) cassette `name`.
    pub fn cassette(mut self, name: &str) -> Self {
        self.source = Source::Cassette(name.to_owned());
        self
    }

    /// Talks to the real provider directly (LIVE tier).
    pub fn live(mut self, provider: LiveProvider) -> Self {
        self.source = Source::Live(provider);
        self
    }

    pub fn fixture(mut self, fixture: Fixture) -> Self {
        self.fixture = fixture;
        self
    }

    /// The global access mode set with the model (not for `F0-empty`).
    pub fn access(mut self, access: Access) -> Self {
        self.access = access;
        self
    }

    pub fn env(mut self, key: &str, value: impl Into<String>) -> Self {
        self.env.push((key.to_owned(), value.into()));
        self
    }

    pub fn model(mut self, choice: ModelChoice) -> Self {
        self.model = Some(choice);
        self
    }

    /// Records cassette traffic into `dir` (LIVE-09 drift check), whatever
    /// `BUTLER_E2E_RECORD` says.
    pub fn record_into(mut self, dir: std::path::PathBuf) -> Self {
        self.record_into = Some(dir);
        self
    }

    /// Replay without the placeholder Codex credential (no provider auth).
    pub fn without_credential(mut self) -> Self {
        self.stub_credential = false;
        self
    }

    pub fn placeholder(mut self, name: &str, value: impl Into<String>) -> Self {
        self.placeholders.add(name, value);
        self
    }

    pub async fn start(self) -> Result<Scenario, HarnessError> {
        let Self {
            id,
            sandbox,
            placeholders,
            fixture,
            access,
            source,
            env,
            model,
            stub_credential,
            record_into,
        } = self;
        let mut launch = Launch::new(&sandbox)?;
        let default_model = ModelChoice {
            model: "openai/gpt-6-sol".into(),
            effort: Some("low".into()),
        };
        let (provider, choice, credential) = match source {
            Source::None => (None, model.unwrap_or(default_model), None),
            Source::Live(live_provider) => live_source(&live_provider, model, &mut launch),
            Source::Cassette(name) if flag("BUTLER_E2E_RECORD") || record_into.is_some() => {
                record_source(&name, model, &placeholders, record_into, &mut launch).await?
            }
            Source::Cassette(name) => {
                let stub_codex_home = stub_credential.then(|| sandbox.codex_home());
                replay_source(&name, &placeholders, stub_codex_home, &mut launch).await?
            }
        };
        if let Some((_, credential)) = &credential {
            apply_credential(&mut launch, credential, &choice);
        }
        for (key, value) in env {
            launch.set_env(&key, value);
        }
        match fixture {
            Fixture::Ready => fixtures::ready(&sandbox.data, &choice.model)?,
            Fixture::Legacy => fixtures::legacy(&sandbox.data, &choice.model)?,
            Fixture::FirstConversation => fixtures::first_conversation(&sandbox.data, &choice.model)?,
            Fixture::Empty => {}
        }
        let (agent, gw) = Agent::start(launch).await?;
        let scenario = Scenario {
            id,
            gw,
            agent,
            provider,
            model: choice,
            sandbox,
        };
        if let Some((provider_name, Credential::ApiKey { env_var })) = &credential
            && scenario.model.provider() != "openai"
        {
            scenario.register_api_key(provider_name, env_var).await?;
        }
        if fixture != Fixture::Empty {
            let mut settings = model_settings(&scenario.model);
            settings["access_mode"] = access.as_str().into();
            scenario.patch_settings(settings, &scenario.model.label()).await?;
        }
        Ok(scenario)
    }
}

/// A provider source plus the credential the agent runs with.
type SourceSetup = (Option<Provider>, ModelChoice, Option<(String, Credential)>);

/// Live mode: the agent talks to the real provider directly.
fn live_source(
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
async fn replay_source(
    name: &str,
    placeholders: &Placeholders,
    stub_codex_home: Option<std::path::PathBuf>,
    launch: &mut Launch,
) -> Result<SourceSetup, HarnessError> {
    let cassette = Cassette::load(name)?;
    let choice = ModelChoice {
        model: cassette.meta.model.clone(),
        effort: cassette.meta.effort.clone(),
    };
    let provider_name = cassette.meta.provider.clone();
    let provider = Provider::replay(cassette, placeholders.clone()).await?;
    if let Some(key) = super::config::base_url_env(&provider_name) {
        launch.set_env(key, provider.base_url.clone());
    }
    if provider_name == "openai-subscription"
        && let Some(codex_home) = stub_codex_home
    {
        fixtures::stub_codex_auth(&codex_home)?;
    }
    Ok((Some(provider), choice, None))
}

/// Record mode: a proxy that forwards cassette `name` to the live provider
/// and records it (`BUTLER_E2E_RECORD=1` or [`Setup::record_into`]).
async fn record_source(
    name: &str,
    model: Option<ModelChoice>,
    placeholders: &Placeholders,
    record_into: Option<std::path::PathBuf>,
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
        ..Meta::default()
    };
    let provider = Provider::record(upstream, meta, placeholders.clone(), record_into).await?;
    if let Some(key) = live_provider.base_url_env() {
        launch.set_env(key, provider.base_url.clone());
    }
    let credential = live_provider
        .credential
        .clone()
        .map(|c| (live_provider.provider.clone(), c));
    Ok((Some(provider), choice, credential))
}

/// Points the agent at `credential` through the product's own variables.
fn apply_credential(launch: &mut Launch, credential: &Credential, choice: &ModelChoice) {
    match credential {
        Credential::CodexProfile(path) => {
            launch.set_env("BUTLER_CODEX_AUTH_PROFILE", path.display().to_string());
        }
        Credential::CodexAuthJson(path) => {
            launch.set_env("CODEX_AUTH_JSON", path.display().to_string());
        }
        Credential::ApiKey { env_var } => {
            if choice.provider() == "openai"
                && let Some(value) = super::config::nonempty(env_var)
            {
                launch.set_env("OPENAI_API_KEY", value);
            }
        }
    }
}

pub const SANITIZATION: &[&str] = &[
    "per-run values -> {{W}}, {{D}}, {{SANDBOX}}, scenario nonces",
    "JWT/sk-key/bearer/email/home path/host name -> fixed placeholders",
    "response.instructions -> {{REDACTED_ECHO}}, response.tools -> []",
    "response headers reduced to content-type, retry-after",
    "chunks re-cut at SSE event boundaries (event bytes unchanged)",
];

impl Scenario {
    pub async fn select_model(&self, choice: &ModelChoice) -> Result<Reply, HarnessError> {
        self.patch_settings(model_settings(choice), &choice.label())
            .await
    }

    /// `PATCH /settings` with `body`; `what` names it in the error.
    pub async fn patch_settings(&self, body: Value, what: &str) -> Result<Reply, HarnessError> {
        let reply = self.gw.patch("/settings", body).await?;
        if reply.status != 200 {
            return Err(harness_error(format!(
                "fixture: PATCH /settings {what} failed: {} {}",
                reply.status, reply.text
            )));
        }
        Ok(reply)
    }

    async fn register_api_key(&self, provider: &str, env_var: &str) -> Result<(), HarnessError> {
        let key = super::config::nonempty(env_var)
            .ok_or_else(|| harness_error(format!("{env_var} is empty")))?;
        let reply = self
            .gw
            .post(
                "/model-catalog/provider-credentials",
                json!({"provider_id": provider, "auth_type": "api_key", "api_key": key}),
            )
            .await?;
        if reply.status >= 300 {
            return Err(harness_error(format!(
                "provider credential registration failed: {}",
                reply.status
            )));
        }
        Ok(())
    }

    /// Restart (SIGTERM, then start on the same data dir and port).
    pub async fn restart(&mut self) -> Result<(), HarnessError> {
        self.gw = self.agent.restart().await?;
        Ok(())
    }

    /// SIGKILL then start again.
    pub async fn crash_and_restart(&mut self) -> Result<(), HarnessError> {
        self.agent.kill9()?;
        self.gw = self.agent.start_again().await?;
        Ok(())
    }

    /// Stops the provider: replay checks strictness, record writes cassettes.
    pub async fn finish(mut self) -> Result<(), HarnessError> {
        match self.provider.take() {
            Some(provider) => provider.finish().await,
            None => Ok(()),
        }
    }

    pub fn provider(&self) -> Result<&Provider, HarnessError> {
        self.provider
            .as_ref()
            .ok_or_else(|| harness_error("scenario has no provider"))
    }

    pub fn recording(&self) -> bool {
        self.provider.as_ref().is_some_and(Provider::is_recording)
    }

    /// Acts as the App's process supervisor: when the agent has exited on its
    /// own (the service exits after an interrupted turn so the supervisor can
    /// replace the process), start it again. Returns true when it restarted.
    pub async fn supervise(&mut self) -> Result<bool, HarnessError> {
        if self.agent.is_running() {
            return Ok(false);
        }
        self.agent.reap();
        self.gw = self.agent.start_again().await?;
        Ok(true)
    }

    /// Like [`Scenario::turn`], restarting the agent whenever it exits.
    /// Returns the terminal turn and the number of process replacements.
    pub async fn turn_supervised(
        &mut self,
        chat: &str,
        text: &str,
    ) -> Result<(String, Value, u32), HarnessError> {
        let accepted = self.gw.say(chat, text).await?;
        let turn_id = accepted_turn_id(&accepted)?;
        let deadline = std::time::Instant::now() + Duration::from_secs(turn_timeout());
        let mut restarts = 0;
        loop {
            if self.supervise().await? {
                restarts += 1;
            }
            if let Ok(Some(turn)) = self.gw.turn(chat, &turn_id).await
                && super::gateway::TERMINAL.contains(&super::gateway::turn_state(&turn))
            {
                return Ok((turn_id, turn, restarts));
            }
            if std::time::Instant::now() > deadline || restarts > 5 {
                let misses = self
                    .provider
                    .as_ref()
                    .map(Provider::misses)
                    .unwrap_or_default();
                return Err(harness_error(format!(
                    "turn {turn_id} not terminal (restarts: {restarts}); replay misses: {misses:#?}"
                )));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Sends `text` to `chat` and waits for a terminal state.
    pub async fn turn(&self, chat: &str, text: &str) -> Result<(String, Value), HarnessError> {
        let accepted = self.gw.say(chat, text).await?;
        let turn_id = accepted_turn_id(&accepted)?;
        let turn = self
            .gw
            .wait_terminal(chat, &turn_id, Duration::from_secs(turn_timeout()))
            .await?;
        Ok((turn_id, turn))
    }
}

/// The settings that select `choice` (model and reasoning effort).
fn model_settings(choice: &ModelChoice) -> Value {
    let mut body = json!({"model": choice.model});
    if let Some(effort) = &choice.effort {
        body["reasoning_effort"] = Value::String(effort.clone());
    }
    body
}

pub fn accepted_turn_id(accepted: &Value) -> Result<String, HarnessError> {
    accepted["turn_id"]
        .as_str()
        .or_else(|| accepted["turn"]["turn_id"].as_str())
        .or_else(|| accepted["turn"]["id"].as_str())
        .map(str::to_owned)
        .ok_or_else(|| harness_error(format!("no turn id in accepted message: {accepted}")))
}

pub fn turn_timeout() -> u64 {
    if flag("BUTLER_E2E_RECORD") || super::config::Tier::from_env().runs_live() {
        300
    } else {
        60
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
