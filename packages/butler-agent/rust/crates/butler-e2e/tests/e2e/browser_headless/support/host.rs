//! The gpui shell attached to a scenario's agent as its browser page host
//! (`BUTLER_E2E_BROWSER_BACKEND=shell`): started once per agent, ended with the test.
use crate::shell_app::driver::{SHOTS, Shell};
use butler_e2e::e2e::{
    HarnessError,
    config::nonempty,
    harness_error,
    scenario::{Scenario, Setup},
    security::AdminClient,
};
use reqwest::Method;
use serde_json::json;
use std::{
    ops::{Deref, DerefMut},
    time::{Duration, Instant},
};
use tokio::{sync::oneshot, task::JoinHandle};

/// The shell is the App: it attaches to an agent the App supervises, with no Electron host.
pub(crate) fn shell() -> bool {
    super::backend().as_deref() == Ok("shell")
}

/// The shell needs the harness executable and a staged CEF; without them the scenario skips.
pub(super) fn runnable() -> bool {
    let missing = [SHOTS, "BUTLER_CEF_DIR"]
        .into_iter()
        .find(|name| nonempty(name).is_none());
    if let Some(name) = missing {
        eprintln!("butler-e2e: SKIPPED ({name} is not set)");
    }
    missing.is_none()
}

/// A scenario setup that starts the shell after the agent when the shell backend is selected.
pub(crate) struct Pending(Setup);

impl Pending {
    pub(super) fn new(setup: Setup) -> Self {
        Self(setup)
    }

    pub(crate) fn env(self, key: &str, value: impl Into<String>) -> Self {
        Self(self.0.env(key, value))
    }

    pub(crate) fn data_folder_token(self) -> Self {
        Self(self.0.data_folder_token())
    }

    pub(crate) async fn start(self) -> Result<Hosted, HarnessError> {
        let scenario = self.0.start().await?;
        if !shell() {
            return Ok(Hosted {
                pump: None,
                scenario,
            });
        }
        // It must attach to the scenario's agent, never start one of its own.
        let agent = [(
            "BUTLER_NATIVE_AGENT_EXECUTABLE",
            "/nonexistent/butler-agent".to_owned(),
        )];
        let mut shell = Shell::start(&scenario.sandbox, &agent).await?;
        shell.run(&["agent running"]).await?;
        let pump = Pump::start(shell);
        if let Err(error) = attached(&scenario).await {
            return Err(harness_error(format!("{error}; {}", pump.report().await)));
        }
        Ok(Hosted {
            pump: Some(pump),
            scenario,
        })
    }
}

impl Deref for Pending {
    type Target = Setup;
    fn deref(&self) -> &Setup {
        &self.0
    }
}

/// A running scenario; the shell (if any) is stopped, and so killed, before the agent.
pub(crate) struct Hosted {
    pump: Option<Pump>,
    scenario: Scenario,
}

impl Hosted {
    pub(crate) async fn finish(self) -> Result<(), HarnessError> {
        let Self { pump, scenario } = self;
        if let Some(pump) = pump {
            let mut shell = pump.stop().await?;
            shell.run(&["app-quit"]).await?;
            shell.finish().await?;
        }
        scenario.finish().await
    }
}

impl Deref for Hosted {
    type Target = Scenario;
    fn deref(&self) -> &Scenario {
        &self.scenario
    }
}

impl DerefMut for Hosted {
    fn deref_mut(&mut self) -> &mut Scenario {
        &mut self.scenario
    }
}

/// The headless shell only runs while a command is being answered (its executor is stepped by
/// the harness), so a background task keeps it running for as long as the test uses the agent.
struct Pump {
    stop: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<Result<Shell, HarnessError>>>,
}

impl Pump {
    fn start(mut shell: Shell) -> Self {
        let (stop, mut stopped) = oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            // Checked between commands only: an answer is never left unread.
            while matches!(stopped.try_recv(), Err(oneshot::error::TryRecvError::Empty)) {
                shell.run(&["wait 50"]).await?;
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Ok(shell)
        });
        Self {
            stop: Some(stop),
            task: Some(task),
        }
    }

    async fn stop(mut self) -> Result<Shell, HarnessError> {
        let _ = self.stop.take().map(|stop| stop.send(()));
        let task = self
            .task
            .take()
            .ok_or_else(|| harness_error("shell pump"))?;
        task.await
            .map_err(|error| harness_error(error.to_string()))?
    }

    /// What the shell's supervisor saw (stops the shell).
    async fn report(self) -> String {
        let seen = async {
            let mut shell = self.stop().await?;
            shell.run(&["diagnostics attach"]).await?;
            shell.report("attach")
        };
        match seen.await {
            Ok(report) => format!("shell: {report}"),
            Err(error) => format!("shell: {error}"),
        }
    }
}

impl Drop for Pump {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/// The agent answers the page host's CDP channel (empty batch) only once a page host is
/// attached; before that it refuses with 409 `no_page_host`.
async fn attached(s: &Scenario) -> Result<(), HarnessError> {
    let credential = s
        .agent
        .launch
        .admin_credential()
        .ok_or_else(|| harness_error("the agent has no admin credential"))?;
    let admin = AdminClient::new(s.gw.clone(), credential);
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let reply = admin
            .send(
                Method::POST,
                "/internal/browser-host/cdp",
                Some(json!({"messages": []})),
                &[],
            )
            .await?;
        if reply.status == 200 {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(harness_error(format!(
                "the shell did not attach as page host within 30 s (last answer {}: {})",
                reply.status, reply.text
            )));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
