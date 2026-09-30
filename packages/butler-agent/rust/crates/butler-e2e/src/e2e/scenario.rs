//! Scenario setup: sandbox + fixture + provider (replay, record or live) +
//! agent process, in one builder.
//!
//! ```text
//! let setup = Setup::new("TURN-01")?.cassette("TURN-01");
//! std::fs::write(setup.sandbox.workspace.join("notes.txt"), &nonce)?;
//! let mut s = setup.start().await?;
//! ```

use std::time::Duration;

use super::cassette::Cassette;
use serde_json::{Value, json};

use super::agent::{Agent, Launch};
use super::config::{Credential, LiveProvider, ModelChoice, flag};
use super::fixtures;
use super::gateway::{Gateway, Reply};
use super::provider::Provider;
use super::sandbox::Sandbox;
use super::sanitize::Placeholders;
use super::{HarnessError, harness_error};

mod sources;
mod stub;

use sources::{apply_credential, live_source, record_source, replay_source, stub_source};

pub use sources::STUB_REFRESH_TOKEN;

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
    Stub(Cassette),
    Live(LiveProvider),
}

/// How the harness starts the agent and where its gateway token lives.
#[derive(Clone, Copy)]
enum LaunchMode {
    /// The harness's token file, named by the local-auth variables.
    Harness,
    /// As the Butler App starts and supervises it ([`Setup::app_supervisor`]).
    AppSupervisor,
    /// As `butler start` does: the token in the data folder
    /// ([`Setup::data_folder_token`]).
    DataFolderToken,
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
    launch_mode: LaunchMode,
    replay_only: bool,
    extends: Option<String>,
    login_refresh: bool,
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
            launch_mode: LaunchMode::Harness,
            replay_only: false,
            extends: None,
            login_refresh: false,
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

    /// Starts the agent without token variables, as `butler start` does:
    /// the agent owns the token in its data folder.
    pub fn data_folder_token(mut self) -> Self {
        self.launch_mode = LaunchMode::DataFolderToken;
        self
    }

    /// The cassette extends `base`: recording replays what `base` has a
    /// recording for (the scenario repeats that scenario's steps) and keeps
    /// only the new requests; replay serves both.
    pub fn extends(mut self, base: &str) -> Self {
        self.extends = Some(base.to_owned());
        self
    }

    /// Always replays the cassette, also under `BUTLER_E2E_RECORD=1`: for
    /// scenarios that reuse another scenario's recording or inject faults
    /// into it, so a record run can never overwrite that cassette.
    pub fn replay_only(mut self) -> Self {
        self.replay_only = true;
        self
    }

    /// Sends the Codex login refresh through the provider
    /// ([`sources::route_login_refresh`]).
    pub fn codex_login_refresh(mut self) -> Self {
        self.login_refresh = true;
        self
    }

    /// Lets the agent poll provider quota endpoints (off by default).
    pub fn quota_polling(self) -> Self {
        self.env("BUTLER_PROVIDER_QUOTA_POLLING", "1")
    }

    /// Replay without the placeholder Codex credential (no provider auth).
    pub fn without_credential(mut self) -> Self {
        self.stub_credential = false;
        self
    }

    /// Starts and supervises the agent as the Butler App does: gateway token
    /// in the data dir's App local-auth file, foreground lease, App gateway
    /// forced on, and a restart the intent hands to the App carried out by
    /// the harness ([`Launch::use_app_supervisor`]).
    pub fn app_supervisor(mut self) -> Self {
        self.launch_mode = LaunchMode::AppSupervisor;
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
            launch_mode,
            replay_only,
            extends,
            login_refresh,
        } = self;
        let mut launch = Launch::new(&sandbox)?;
        match launch_mode {
            LaunchMode::Harness => {}
            LaunchMode::AppSupervisor => launch.use_app_supervisor()?,
            LaunchMode::DataFolderToken => launch.use_data_folder_token(),
        }
        let default_model = ModelChoice {
            model: "openai/gpt-6-sol".into(),
            effort: Some("low".into()),
        };
        let (provider, choice, credential) = match source {
            Source::None => (None, model.unwrap_or(default_model), None),
            Source::Live(live_provider) => live_source(&live_provider, model, &mut launch),
            Source::Stub(cassette) => {
                stub_source(
                    cassette,
                    &placeholders,
                    stub_credential.then(|| sandbox.codex_home()),
                    &mut launch,
                )
                .await?
            }
            Source::Cassette(name)
                if (flag("BUTLER_E2E_RECORD") && !replay_only) || record_into.is_some() =>
            {
                record_source(
                    &name,
                    model,
                    &placeholders,
                    record_into,
                    extends,
                    &mut launch,
                )
                .await?
            }
            Source::Cassette(name) => {
                let stub_codex_home = stub_credential.then(|| sandbox.codex_home());
                replay_source(&name, &placeholders, stub_codex_home, &mut launch).await?
            }
        };
        if let Some((provider_name, credential)) = &credential {
            apply_credential(&mut launch, provider_name, credential, &choice);
        }
        if login_refresh && let Some(provider) = &provider {
            sources::route_login_refresh(&mut launch, provider, &sandbox)?;
        }
        for (key, value) in env {
            launch.set_env(&key, value);
        }
        match fixture {
            Fixture::Ready => fixtures::ready(&sandbox.data, &choice.model)?,
            Fixture::Legacy => fixtures::legacy(&sandbox.data, &choice.model)?,
            Fixture::FirstConversation => {
                fixtures::first_conversation(&sandbox.data, &choice.model)?;
            }
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
            scenario
                .patch_settings(settings, &scenario.model.label())
                .await?;
        }
        Ok(scenario)
    }
}

pub const SANITIZATION: &[&str] = &[
    "per-run values -> {{W}}, {{D}}, {{SANDBOX}}, scenario nonces",
    "JWT/sk-key/bearer/email/home path/host name -> fixed placeholders",
    "response.instructions -> {{REDACTED_ECHO}}, response.tools -> []",
    "response headers reduced to content-type, retry-after and numeric quota headers",
    "chunks re-cut at SSE event boundaries (event bytes unchanged)",
    "JSON account identifiers (account_id, user_id, email, ...) -> {{ACCOUNT}}/{{EMAIL}}",
    "JSON tokens (access_token, refresh_token, id_token, authorization) -> {{TOKEN}}",
    "absolute reset times -> {{EPOCH_MS|S+delta}} relative to recording, rounded to the hour",
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
    /// That exit must be non-zero: launchd and systemd restart only an Agent
    /// that exits non-zero.
    pub async fn supervise(&mut self) -> Result<bool, HarnessError> {
        if self.agent.is_running() {
            return Ok(false);
        }
        if let Some(status) = self.agent.reap()
            && status.success()
        {
            return Err(harness_error(format!(
                "the agent exited on its own with {status}; an exit that needs a replacement must be non-zero"
            )));
        }
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
