//! The setup bridge (`setup-bridge.mjs`, foreground path): the local checks behind
//! `/setup/start|status|cancel|diagnostics`, run in process; repair goes through the supervisor.
//! Views carry phases, ids and codes, never display text; the screens localize them.

mod redact;

use std::time::Duration;

use gpui::{App, AsyncApp, Global};
use serde_json::{Map, Value, json};

use super::supervisor::{Supervisor, SupervisorError};
use super::{Answer, logs, runtime};
use crate::ui::source::agent::Jobs;

/// `startFirstRunSetup(mode)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SetupMode {
    Check,
    Repair,
}

/// The ids of the checks, in order; the screens name each step in the reader's language.
const CHECKS: [&str; 7] = [
    "agent_runtime",
    "managed_gateway",
    "bundled_agent_version",
    "local_auth",
    "health",
    "protocol",
    "gateway_profile",
];
/// `gatewayReadyPollAttempts` / `gatewayReadyPollDelayMs`.
const GATEWAY_ATTEMPTS: u32 = 120;
const GATEWAY_DELAY: Duration = Duration::from_millis(250);
/// Codes `setupErrorCode` lets through; anything else is `setup_failed`.
const KNOWN_CODES: [&str; 8] = [
    "legacy_data_blocked",
    "service_registration_unavailable",
    "agent_service_not_ready",
    "agent_service_failed",
    "gateway_profile_mismatch",
    "bundled_agent_version_missing",
    "local_auth_unavailable",
    "health_unavailable",
];

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Phase {
    #[default]
    Idle,
    Checking,
    Ready,
    Failed,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Checking => "checking",
            Self::Ready => "ready",
            Self::Failed => "failed",
        }
    }
}

#[derive(Default)]
struct Session {
    phase: Phase,
    checks: Vec<(&'static str, &'static str)>,
    error_code: Option<&'static str>,
    details: Option<Value>,
}

/// `runId` and the current session.
#[derive(Default)]
struct SetupState {
    run: u64,
    session: Session,
}

impl Global for SetupState {}

/// A failed step: the code the screen sees, and what the support details name.
struct Failure {
    code: &'static str,
    exception_code: Option<String>,
    message: Option<String>,
}

impl Failure {
    /// `setupError(code)`.
    fn coded(code: &'static str) -> Self {
        Self {
            code: known(code),
            exception_code: Some(code.to_owned()),
            message: Some(code.to_owned()),
        }
    }

    fn supervisor(error: SupervisorError) -> Self {
        Self::coded(error.code())
    }

    fn other(message: String) -> Self {
        Self {
            code: "setup_failed",
            exception_code: None,
            message: Some(message),
        }
    }
}

fn known(code: &str) -> &'static str {
    KNOWN_CODES
        .iter()
        .find(|entry| **entry == code)
        .copied()
        .unwrap_or("setup_failed")
}

fn status_view(session: &Session) -> Value {
    let mut view = json!({ "phase": session.phase.as_str(), "diagnostics_available": true });
    if let (Some(code), Some(fields)) = (session.error_code, view.as_object_mut()) {
        fields.insert("error_code".into(), code.into());
    }
    view
}

/// The status view (`GET /setup/status`).
pub(crate) fn status(cx: &App) -> Value {
    match cx.try_global::<SetupState>() {
        Some(state) => status_view(&state.session),
        None => status_view(&Session::default()),
    }
}

/// The redacted bug-report view (`GET /setup/diagnostics`).
pub(crate) fn diagnostics(cx: &App) -> Value {
    let session = cx.try_global::<SetupState>().map(|state| &state.session);
    let checks: Vec<Value> = session
        .map(|session| session.checks.iter())
        .into_iter()
        .flatten()
        .map(|(id, status)| json!({ "id": id, "status": status }))
        .collect();
    let errors: Vec<Value> = session
        .and_then(|session| session.error_code.map(|code| (code, &session.details)))
        .into_iter()
        .map(|(code, details)| {
            let mut error = json!({ "code": code });
            if let (Some(details), Some(fields)) = (details, error.as_object_mut()) {
                fields.insert("details".into(), details.clone());
            }
            error
        })
        .collect();
    let crashes = runtime(cx).map(|runtime| logs::read_crashes(&runtime.read(cx).data));
    json!({
        "generated_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "phase": session.map_or(Phase::Idle, |session| session.phase).as_str(),
        "checks": checks,
        "errors": errors,
        "ui_crashes": redact::strings(&Value::Array(crashes.unwrap_or_default())),
    })
}

/// Runs the checks (`POST /setup/start`) and returns the status view.
pub(crate) async fn start(mode: SetupMode, cx: &mut AsyncApp) -> Value {
    let run = cx.update(begin);
    if let Err(failure) = checks(mode, run, cx).await
        && cx.update(|cx| active(cx, run))
    {
        let runtime = runtime_diagnostics(cx).await;
        cx.update(|cx| fail(cx, run, &failure, &runtime));
    }
    cx.update(|cx| status(cx))
}

fn begin(cx: &mut App) -> u64 {
    let state = cx.default_global::<SetupState>();
    state.run += 1;
    state.session = Session {
        phase: Phase::Checking,
        checks: CHECKS.iter().map(|id| (*id, "pending")).collect(),
        ..Session::default()
    };
    state.run
}

/// `isActiveRun`: this run is still the current one and still checking.
fn active(cx: &App, run: u64) -> bool {
    cx.try_global::<SetupState>()
        .is_some_and(|state| state.run == run && state.session.phase == Phase::Checking)
}

fn mark(cx: &mut AsyncApp, run: u64, id: &str) {
    cx.update(|cx| {
        let state = cx.default_global::<SetupState>();
        if state.run != run {
            return;
        }
        for check in &mut state.session.checks {
            if check.0 == id {
                check.1 = "passed";
            }
        }
    });
}

fn fail(cx: &mut App, run: u64, failure: &Failure, runtime: &Value) {
    let mut details = Map::new();
    details.insert("setup_error_code".into(), failure.code.into());
    if let Some(code) = &failure.exception_code {
        details.insert("exception_code".into(), code.clone().into());
    }
    if let Some(message) = &failure.message {
        details.insert("exception_message".into(), redact::text(message).into());
    }
    details.insert("runtime".into(), runtime.clone());
    details.insert("service".into(), Value::Null);
    details.insert("raw_text_included".into(), Value::Bool(false));
    let state = cx.default_global::<SetupState>();
    if state.run != run {
        return;
    }
    let checks = state
        .session
        .checks
        .iter()
        .map(|&(id, status)| {
            (
                id,
                if status == "pending" {
                    "failed"
                } else {
                    status
                },
            )
        })
        .collect();
    state.session = Session {
        phase: Phase::Failed,
        checks,
        error_code: Some(failure.code),
        details: Some(redact::value(&Value::Object(details))),
    };
}

/// The checks in order; an `Err` while the run is no longer active is dropped by the caller.
async fn checks(mode: SetupMode, run: u64, cx: &mut AsyncApp) -> Result<(), Failure> {
    if mode == SetupMode::Repair {
        let answer = cx.update(|cx| ask(cx, Supervisor::repair));
        settle(answer).await?;
    }
    mark(cx, run, "agent_runtime");
    wait_for_gateway(run, cx).await?;
    live(cx, run)?;
    mark(cx, run, "managed_gateway");
    let runtime = runtime_diagnostics(cx).await;
    let flag = |pointer: &str| runtime.pointer(pointer).and_then(Value::as_bool) == Some(true);
    let bundled = flag("/bundled_agent/version_configured")
        || runtime
            .pointer("/bundled_agent/source")
            .and_then(Value::as_str)
            == Some("development");
    if !bundled {
        return Err(Failure::coded("bundled_agent_version_missing"));
    }
    mark(cx, run, "bundled_agent_version");
    if !(flag("/local_auth/required") && flag("/local_auth/token_configured")) {
        return Err(Failure::coded("local_auth_unavailable"));
    }
    mark(cx, run, "local_auth");
    if runtime.get("phase").and_then(Value::as_str) != Some("running") {
        return Err(Failure::coded("health_unavailable"));
    }
    mark(cx, run, "health");
    let settings = read_settings(run, cx).await?;
    live(cx, run)?;
    mark(cx, run, "protocol");
    // The Agent still reports the `electron` gateway profile.
    if settings.get("gateway_profile").and_then(Value::as_str) != Some("electron") {
        return Err(Failure::coded("gateway_profile_mismatch"));
    }
    mark(cx, run, "gateway_profile");
    cx.update(|cx| {
        let state = cx.default_global::<SetupState>();
        if state.run == run && state.session.phase == Phase::Checking {
            state.session.phase = Phase::Ready;
        }
    });
    Ok(())
}

fn live(cx: &mut AsyncApp, run: u64) -> Result<(), Failure> {
    if cx.update(|cx| active(cx, run)) {
        Ok(())
    } else {
        Err(Failure::coded("agent_service_not_ready"))
    }
}

fn ask(cx: &App, command: impl FnOnce(&Supervisor) -> Answer) -> Option<Answer> {
    runtime(cx).map(|runtime| command(&runtime.read(cx).supervisor))
}

/// A supervisor command's answer, or the failure it carries.
async fn settle(answer: Option<Answer>) -> Result<(), Failure> {
    match answer {
        Some(answer) => match answer.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(Failure::supervisor(error)),
            Err(_) => Err(Failure::other("supervisor unavailable".into())),
        },
        None => Err(Failure::other("supervisor unavailable".into())),
    }
}

/// `waitForGatewayReady`: `ensureReady` until it holds, 120 tries 250 ms apart, while the run
/// is active.
async fn wait_for_gateway(run: u64, cx: &mut AsyncApp) -> Result<(), Failure> {
    let mut last = None;
    for attempt in 1..=GATEWAY_ATTEMPTS {
        if !cx.update(|cx| active(cx, run)) {
            break;
        }
        let answer = cx.update(|cx| ask(cx, Supervisor::ensure_ready));
        match settle(answer).await {
            Ok(()) => return Ok(()),
            Err(failure) => last = Some(failure),
        }
        if attempt == GATEWAY_ATTEMPTS {
            break;
        }
        butler_ds::ui::motion::sleep(cx.background_executor(), GATEWAY_DELAY).await;
    }
    Err(last.unwrap_or_else(|| Failure::coded("agent_service_not_ready")))
}

/// `readSettings`. The window's client may attach a moment after the supervisor reports
/// ready, so a missing client is retried like the gateway wait; a refusal is not.
async fn read_settings(run: u64, cx: &mut AsyncApp) -> Result<Value, Failure> {
    for attempt in 1..=GATEWAY_ATTEMPTS {
        live(cx, run)?;
        let request =
            cx.update(|cx| Jobs::run(cx, |client| async move { client.get_settings().await }));
        match request.await {
            Some(Ok(settings)) => return Ok(settings),
            Some(Err(error)) => return Err(Failure::other(error.to_string())),
            None if attempt == GATEWAY_ATTEMPTS => break,
            None => butler_ds::ui::motion::sleep(cx.background_executor(), GATEWAY_DELAY).await,
        }
    }
    Err(Failure::other("agent unavailable".into()))
}

/// `safeReadRuntimeDiagnostics`: the supervisor's diagnostics, sanitized.
async fn runtime_diagnostics(cx: &mut AsyncApp) -> Value {
    let receiver =
        cx.update(|cx| runtime(cx).map(|runtime| runtime.read(cx).supervisor.diagnostics()));
    let raw = match receiver {
        Some(receiver) => receiver.await.ok(),
        None => None,
    };
    match raw {
        Some(raw) => redact::value(&raw),
        None => json!({ "phase": "unavailable", "raw_text_included": false }),
    }
}
