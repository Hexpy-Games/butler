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
use super::config::{Credential, LiveProvider, ModelChoice, flag};
use super::fixtures;
use super::gateway::{Gateway, Reply};
use super::provider::Provider;
use super::sandbox::Sandbox;
use super::sanitize::Placeholders;
use super::{HarnessError, harness_error};

mod sources;

use sources::{apply_credential, live_source, record_provider, replay_provider};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fixture {
    /// `F0-empty`.
    Empty,
    /// `F1-ready`.
    Ready,
    /// `F3-legacy` (synthetic previous-generation data dir).
    Legacy,
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
    source: Source,
    env: Vec<(String, String)>,
    model: Option<ModelChoice>,
    stub_credential: bool,
    record_into: Option<std::path::PathBuf>,
    replay_only: bool,
    extends: Option<String>,
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
            source: Source::None,
            env: Vec::new(),
            model: None,
            stub_credential: true,
            record_into: None,
            replay_only: false,
            extends: None,
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
            source,
            env,
            model,
            stub_credential,
            record_into,
            replay_only,
            extends,
        } = self;
        let mut launch = Launch::new(&sandbox)?;
        let default_model = ModelChoice {
            model: "openai/gpt-6-sol".into(),
            effort: Some("low".into()),
        };
        let (provider, choice, credential) = match source {
            Source::None => (None, model.unwrap_or(default_model), None),
            Source::Live(live_provider) => live_source(&live_provider, model, &mut launch),
            Source::Cassette(name)
                if (flag("BUTLER_E2E_RECORD") && !replay_only) || record_into.is_some() =>
            {
                record_provider(
                    &name,
                    model,
                    record_into,
                    extends,
                    &placeholders,
                    &mut launch,
                )
                .await?
            }
            Source::Cassette(name) => {
                let (provider, choice, subscription) =
                    replay_provider(&name, &placeholders, &mut launch).await?;
                if subscription && stub_credential {
                    fixtures::stub_codex_auth(&sandbox.codex_home())?;
                }
                (Some(provider), choice, None)
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
            scenario.select_model(&scenario.model.clone()).await?;
        }
        Ok(scenario)
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
        let mut body = json!({"model": choice.model});
        if let Some(effort) = &choice.effort {
            body["reasoning_effort"] = Value::String(effort.clone());
        }
        let reply = self.gw.patch("/settings", body).await?;
        if reply.status != 200 {
            return Err(harness_error(format!(
                "fixture: PATCH /settings {} failed: {} {}",
                choice.label(),
                reply.status,
                reply.text
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
