//! The native shell as the App (gpui port, P3): it starts the Agent itself, as Electron's
//! foreground mode does, and the user goes through the first run to the workspace; the
//! supervisor carries out `butler restart` and Quit. The shell runs headless through
//! `butler-shell-shots --app` (its live harness: one stdin command per step, each answered
//! `LIVE OK`), named by `BUTLER_SHELL_SHOTS_EXECUTABLE`; the shell spawns the sandbox's Agent
//! through `BUTLER_NATIVE_AGENT_EXECUTABLE`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::process::Stdio;
use std::time::{Duration, Instant};

use butler_e2e::e2e::agent::Launch;
use butler_e2e::e2e::config::nonempty;
use butler_e2e::e2e::fake_servers::{
    ChatBehavior, FakeServer, GOOD_KEY, LOCAL_MODEL, LocalCapabilities,
};
use butler_e2e::e2e::gateway::Gateway;
use butler_e2e::e2e::sandbox::Sandbox;
use butler_e2e::e2e::stop_intent::{instance_record, read_intent};
use butler_e2e::e2e::{HarnessError, harness_error};
use serde_json::{Value, json};

pub(super) mod driver;
pub(super) mod live_turns;
use driver::{SERIAL, SHOTS, Shell};
mod chat_end_room;
mod composer_fold;
mod composer_toolbar;
mod focus_fallback;
mod focus_tab;
mod focus_selection;
mod narrow_window;
mod observer_dialog;
mod text_selection;
mod text_size;
mod titlebar_drag;

/// The gateway of the Agent the App started, with the token it created.
/// Registers a local fake model answering with `behavior` and makes it the default model.
async fn default_to_local_model(
    gw: &Gateway,
    behavior: ChatBehavior,
) -> Result<FakeServer, HarnessError> {
    let local = FakeServer::local_models(behavior).await?;
    let model = json!({
        "provider_id": "local", "api_type": "openai_compatible", "platform": "ollama",
        "server_url": format!("{}/v1", local.base_url), "model_id": LOCAL_MODEL,
        "display_name": LOCAL_MODEL, "api_key": "e2e-custom-private-placeholder",
        "context_window_tokens": 131_072, "source": "discovered"
    });
    let reply = gw.post("/model-catalog/local-models", model).await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let model_ref = reply.data()["model"]["model_ref"].clone();
    let settings = gw.patch("/settings", json!({"model": model_ref})).await?;
    assert_eq!(settings.status, 200, "{}", settings.text);
    Ok(local)
}

pub(super) fn gateway(launch: &Launch) -> Gateway {
    let record = instance_record(&launch.data).expect("no instance record");
    let token = launch.data_folder_token().expect("no data folder token");
    let endpoint = record["app_endpoint"].as_str().expect("no app endpoint");
    Gateway::new(endpoint.to_owned(), token)
}

/// No state the windows showed was a failure.
fn assert_never_failed(report: &Value) {
    let states = report["states"].as_array().expect("states");
    assert!(
        !states.iter().any(|s| s == "failed" || s == "restartfailed"),
        "{report}"
    );
}

/// SHELL-APP-01 — On a fresh data folder the App starts the Agent and the first run goes
/// welcome → consent → memory off → Claude with an API key (a loopback stand-in for the
/// provider) → reply language → skip import → ready → the workspace. The Agent then holds the
/// current consent and the completion. The user then picks the theme the system does not show;
/// a second launch on the same data paints it on its first frame and, the onboarding being done,
/// opens the workspace.
#[tokio::test]
async fn shell_app_01_first_run_reaches_the_workspace() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let provider = FakeServer::provider_models().await?;
    let mut sandbox = Sandbox::new("SHELL-APP-01")?;
    let api = format!("{}/v1", provider.base_url);
    let env = [("BUTLER_ANTHROPIC_BASE_URL", api)];
    let mut shell = Shell::start(&sandbox, &env).await?;
    // The headless platform's appearance differs per OS: pick the opposite theme.
    let system_dark = shell.report("first-frame")?["dark"]
        .as_bool()
        .expect("dark");
    let (item, theme) = if system_dark {
        ("theme-item-0-1", "light")
    } else {
        ("theme-item-0-2", "dark")
    };
    let key = format!("type {GOOD_KEY}");
    shell
        .run(&[
            "agent running",
            "wait-anchor first-run-start",
            "click first-run-start",
            "wait-anchor first-run-agree",
            "click first-run-agree",
            "wait-anchor first-run-memory-off",
            "click first-run-memory-off",
            "wait-anchor first-run-memory-continue",
            "click first-run-memory-continue",
            "wait-anchor first-run-card-claude",
            "click first-run-card-claude",
            "wait-anchor first-run-key-field",
            "click first-run-api-key",
            &key,
            "wait-anchor first-run-key-next",
            "click first-run-key-next",
            "wait-anchor first-run-reply-next",
            "click first-run-reply-next",
            "wait-anchor first-run-agents-skip",
            "click first-run-agents-skip",
            "wait-anchor first-run-finish",
            "click first-run-finish",
            "wait-anchor composer",
            "expect-no-anchor first-run-setup",
        ])
        .await?;
    // A local fake model answers the plain-text send of the second launch.
    let answer = "Hello from the fake model.";
    let gw = gateway(&shell.launch);
    let _local = default_to_local_model(
        &gw,
        ChatBehavior {
            answer: answer.into(),
            ..ChatBehavior::default()
        },
    )
    .await?;
    let onboarding = gw.settings().await?["onboarding"].clone();
    assert_eq!(onboarding["consent_version"], 2, "{onboarding}");
    assert!(
        onboarding["completed_at"]
            .as_str()
            .is_some_and(|at| chrono::DateTime::parse_from_rfc3339(at).is_ok()),
        "{onboarding}"
    );
    let (pick, wait) = (format!("click {item}"), format!("wait-theme {theme}"));
    shell
        .run(&[
            "click sidebar-settings",
            "wait-anchor settings-nav-appearance",
            "click settings-nav-appearance",
            "wait-anchor theme-trigger",
            "click theme-trigger",
            &pick,
            &wait,
            "app-quit",
        ])
        .await?;
    assert_never_failed(&shell.report("app-quit")?);
    shell.finish().await?;

    // The second launch opens in the picked theme and reads the new default model; a new chat
    // takes it (the first run's chat keeps its own). Send from the composer.
    let mut shell = Shell::start(&sandbox, &env).await?;
    assert_eq!(shell.report("first-frame")?["dark"], !system_dark);
    let shown = format!("answer {answer}");
    // No toast before the agent is attached: reads wait for it (none fails for want of one).
    let steps = [
        "expect-toasts 0",
        "agent running",
        "wait-anchor composer",
        "expect-no-anchor first-run-setup",
        "new",
        "controls loaded",
        "compose",
    ];
    let send = ["type Hello butler", "key enter", shown.as_str()];
    shell.run(&[&steps[..], &send[..]].concat()).await?;
    let gw = gateway(&shell.launch);
    let mut stored = Vec::new();
    for chat in gw.get("/chats").await?.data().as_array().unwrap() {
        stored.extend(gw.messages(chat["id"].as_str().unwrap()).await?);
    }
    let has = |role: &str, text: &str| {
        stored
            .iter()
            .any(|m| m["role"] == role && m["text"] == text)
    };
    assert!(
        has("user", "Hello butler") && has("assistant", answer),
        "{stored:?}"
    );
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}

/// SHELL-APP-02 — `butler restart` from a terminal stops the App's Agent with an intent the
/// App carries out: the App starts the replacement as its own child, with no failure shown.
/// Quit then ends the lease: the Agent exits 0 by itself (before the kill at 8 s), and the
/// stop intent names that instance.
#[tokio::test]
async fn shell_app_02_restart_and_quit_through_the_supervisor() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-02")?;
    let data = sandbox.data.clone();
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell.run(&["agent running"]).await?;
    let first = instance_record(&data).expect("no instance");
    assert_eq!(first["app_supervised"], true, "{first}");

    let restart = cli_restart(&shell.launch).await?;
    shell
        .run(&["agent running", "diagnostics restarted"])
        .await?;
    let second = instance_record(&data).expect("no instance after restart");
    assert_ne!(second["nonce"], first["nonce"]);
    assert_eq!(restart["data"]["pid"], second["pid"], "{restart}");
    let restarted = shell.report("restarted")?;
    // The replacement is the App's own child, not an Agent it attached to.
    assert_eq!(
        restarted["diagnostics"]["pid"], second["pid"],
        "{restarted}"
    );
    assert_eq!(restarted["diagnostics"]["external_agent_attached"], false);
    let states = restarted["states"].as_array().expect("states");
    assert!(states.iter().any(|s| s == "restarting"), "{restarted}");
    assert_never_failed(&restarted);

    let started = Instant::now();
    shell.run(&["app-quit"]).await?;
    butler_e2e::assert_wall_clock_budget!(started.elapsed(), Duration::from_secs(8), "quit");
    let quit = shell.report("app-quit")?;
    let exit = &quit["diagnostics"]["last_exit"];
    assert_eq!(*exit, json!({"code": 0, "signal": null}), "{quit}");
    assert_never_failed(&quit);
    let intent = read_intent(&data).expect("Quit wrote no stop intent");
    assert_eq!(intent["requested_by"], "app", "{intent}");
    assert_eq!(intent["reason"], "stop", "{intent}");
    assert_eq!(intent["instance_id"], second["nonce"], "{intent}");
    assert_eq!(intent["pid"], second["pid"], "{intent}");
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}

/// Takes the App's credential file once the Agent has logged `[native-app] ready` `ready` times
/// in the shell's output (it relies on `shell.stdout` being truncated by each `Shell::start`).
fn hold_credential(
    stdout: &std::path::Path,
    auth: &std::path::Path,
    held: &std::path::Path,
    ready: usize,
) -> tokio::task::JoinHandle<()> {
    let (stdout, auth, held) = (stdout.to_owned(), auth.to_owned(), held.to_owned());
    let taken = Instant::now();
    tokio::spawn(async move {
        loop {
            let log = std::fs::read(&stdout).unwrap_or_default();
            let log = String::from_utf8_lossy(&log);
            assert!(
                !log.contains("local_auth_unconfigured"),
                "the Agent has no token: {log}"
            );
            if log.matches("[native-app] ready").count() >= ready {
                break;
            }
            butler_e2e::assert_wall_clock_budget!(
                taken.elapsed(),
                Duration::from_secs(60),
                "Agent gateway ready"
            );
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        std::fs::rename(&auth, &held).expect("credential file taken");
    })
}

/// SHELL-APP-15 — An Agent that reported ready outlives an App that cannot connect to it: with
/// the App's credential file out of reach for longer than the 120 s startup deadline, the App
/// keeps its Agent (no stop, no failure state), shows the error while it keeps probing, and
/// reaches Running with the same Agent once the file is back. The same holds for the Agent of an
/// App Restart with the workspace shown (the error notice, no spinner), and the notice's Retry then
/// replaces it.
#[tokio::test]
async fn shell_app_15_a_ready_agent_survives_a_late_app_probe() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-15")?;
    let data = sandbox.data.clone();
    let auth = data.join(butler_platform::data_paths::LOCAL_AUTH);
    let held = auth.with_extension("held");
    // The Agent reads its credential file once at startup, right after writing it, so taking
    // the file earlier races its own write and leaves it without a token for good. It logs
    // `[native-app] ready` once the token is loaded, before it reports ready to the App's
    // probe (the file's only other reader): take the file then, even before the shell
    // reports it started. The Agent's output goes straight into the shell's stdout file.
    let taken = Instant::now();
    let stdout = sandbox.logs.join("shell.stdout");
    let take = hold_credential(&stdout, &auth, &held, 1);
    let mut shell = Shell::start(&sandbox, &[]).await?;
    take.await.expect("credential file taken");
    let mut ready = None;
    while ready.is_none() {
        butler_e2e::assert_wall_clock_budget!(
            taken.elapsed(),
            Duration::from_secs(60),
            "Agent ready"
        );
        ready = instance_record(&data).filter(|record| record["state"] == "ready");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let ready = ready.expect("ready record");
    let pid = ready["pid"].as_u64().expect("pid");

    tokio::time::sleep(Duration::from_secs(125)).await;
    shell.run(&["diagnostics late"]).await?;
    let late = shell.report("late")?;
    let diagnostics = &late["diagnostics"];
    assert_eq!(diagnostics["pid"], pid, "{late}");
    assert_eq!(diagnostics["agent_state"], "starting", "{late}");
    assert_eq!(diagnostics["last_error_code"], "health_timeout", "{late}");
    assert_never_failed(&late);
    assert!(
        !matches!(
            butler_platform::process_control::liveness(u32::try_from(pid).expect("pid")),
            butler_platform::process_control::Liveness::Gone
        ),
        "the App ended its Agent"
    );
    assert!(
        read_intent(&data).is_none(),
        "the App asked the Agent to stop"
    );

    std::fs::rename(&held, &auth)?;
    shell.run(&["agent running", "diagnostics running"]).await?;
    let running = shell.report("running")?;
    assert_eq!(running["diagnostics"]["pid"], pid, "{running}");
    assert!(running["diagnostics"]["last_error"].is_null(), "{running}");
    assert_never_failed(&running);

    // With the workspace shown, the App's own Restart brings an Agent it cannot connect to: the
    // late start shows the error notice, not a spinner that never ends, and the App keeps the
    // Agent. Retry while that start is still pending restarts the Agent with a new one.
    live_turns::complete_onboarding(&gateway(&shell.launch)).await?;
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&["agent running", "wait-anchor composer"])
        .await?;
    let first = instance_record(&data).expect("instance record")["pid"].clone();
    let take = hold_credential(&stdout, &auth, &held, 2);
    shell.run(&["restart"]).await?;
    take.await.expect("credential file taken");
    let taken = Instant::now();
    let mut next = None;
    while next.is_none() {
        butler_e2e::assert_wall_clock_budget!(
            taken.elapsed(),
            Duration::from_secs(60),
            "restarted Agent ready"
        );
        next = instance_record(&data)
            .filter(|record| record["state"] == "ready" && record["pid"] != first);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let held_pid = next.expect("ready record")["pid"].clone();

    tokio::time::sleep(Duration::from_secs(125)).await;
    shell
        .run(&[
            "diagnostics respawn-late",
            "wait-anchor agent-notice",
            "expect-no-anchor agent-notice-spinner",
        ])
        .await?;
    let late = shell.report("respawn-late")?;
    assert_eq!(late["diagnostics"]["pid"], held_pid, "{late}");
    assert_eq!(late["diagnostics"]["agent_state"], "starting", "{late}");
    assert_eq!(
        late["diagnostics"]["last_error_code"], "health_timeout",
        "{late}"
    );
    assert_never_failed(&late);

    shell
        .run(&[
            "click agent-notice-action",
            "agent running",
            "wait-no-anchor agent-notice",
            "diagnostics replaced",
        ])
        .await?;
    let replaced = shell.report("replaced")?;
    assert_ne!(replaced["diagnostics"]["pid"], held_pid, "{replaced}");
    assert!(
        replaced["diagnostics"]["last_error"].is_null(),
        "{replaced}"
    );
    assert_never_failed(&replaced);
    // The Restart the notice's Retry ran replaced the start the first was waiting for: it
    // answers Ok.
    shell.run(&["restart-answers"]).await?;
    let answers = shell.report("restarts")?;
    assert_eq!(answers, json!(["ok"]), "{answers}");
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}

/// `butler restart --json` from a terminal (no App variables), once it reports.
async fn cli_restart(launch: &Launch) -> Result<Value, HarnessError> {
    let mut command = launch.command_without_local_auth();
    command.args(["restart", "--json"]).stdin(Stdio::null());
    let output = tokio::time::timeout(
        Duration::from_secs(120),
        tokio::process::Command::from(command).output(),
    )
    .await
    .map_err(|_| harness_error("butler restart did not return"))??;
    assert!(output.status.success(), "{output:?}");
    Ok(serde_json::from_slice(&output.stdout)?)
}
