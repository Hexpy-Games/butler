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

use std::path::PathBuf;
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
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::process::{Child, ChildStdin};

mod live_turns;

const SHOTS: &str = "BUTLER_SHELL_SHOTS_EXECUTABLE";
/// The App's port for these runs (never the owner's 18765 or the demo's 19765).
const PORT: &str = "28765";

/// One App on the fixed port at a time.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The headless shell, started as the App on the sandbox's data folder.
struct Shell {
    child: Child,
    input: ChildStdin,
    output: BufReader<tokio::fs::File>,
    /// Where the harness writes its reports.
    out: PathBuf,
    launch: Launch,
}

impl Shell {
    async fn start(sandbox: &Sandbox, env: &[(&str, String)]) -> Result<Self, HarnessError> {
        let shots = PathBuf::from(nonempty(SHOTS).unwrap_or_default());
        let mut launch = Launch::new(sandbox)?;
        // The Agent the App starts creates its own token in the data folder.
        launch.use_data_folder_token();
        launch.set_env("BUTLER_APP_SERVER_PORT", PORT);
        launch.set_env("BUTLER_APP_DISABLE_SHELL_REGISTRATION", "1");
        let agent = sandbox.binary.display().to_string();
        launch.set_env("BUTLER_NATIVE_AGENT_EXECUTABLE", agent);
        for (key, value) in env {
            launch.set_env(key, value.clone());
        }
        let out = sandbox.root.join("shell");
        std::fs::create_dir_all(&out)?;
        let stdout = sandbox.logs.join("shell.stdout");
        let mut command = launch.env_command(&shots);
        command
            .arg(&out)
            .arg("--data")
            .arg(&sandbox.data)
            .arg("--app")
            .stdin(Stdio::piped())
            .stdout(std::fs::File::create(&stdout)?)
            .stderr(std::fs::File::create(sandbox.logs.join("shell.stderr"))?);
        let mut child = tokio::process::Command::from(command)
            .kill_on_drop(true)
            .spawn()?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| harness_error("shell stdin"))?;
        let output = BufReader::new(tokio::fs::File::open(&stdout).await?);
        let mut shell = Self {
            child,
            input,
            output,
            out,
            launch,
        };
        shell.ack("LIVE READY").await?;
        Ok(shell)
    }

    /// Reads the harness's output until `expected`; anything else (the Agent's own output
    /// included) is echoed.
    async fn ack(&mut self, expected: &str) -> Result<(), HarnessError> {
        let wait = async {
            let mut line = String::new();
            loop {
                if self.output.read_line(&mut line).await? == 0 {
                    if self.child.try_wait()?.is_some() {
                        return Err(harness_error(format!("shell exited before {expected}")));
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    continue;
                }
                if !line.ends_with('\n') {
                    continue;
                }
                if line.trim() == expected {
                    return Ok(());
                }
                print!("{line}");
                line.clear();
            }
        };
        tokio::time::timeout(Duration::from_secs(150), wait)
            .await
            .map_err(|_| harness_error(format!("shell: no {expected}")))?
    }

    async fn run(&mut self, commands: &[&str]) -> Result<(), HarnessError> {
        for command in commands {
            self.input
                .write_all(format!("{command}\n").as_bytes())
                .await?;
            self.ack("LIVE OK")
                .await
                .map_err(|error| harness_error(format!("{command}: {error}")))?;
        }
        Ok(())
    }

    /// A report the harness wrote (`diagnostics <name>`, `app-quit`).
    fn report(&self, name: &str) -> Result<Value, HarnessError> {
        Ok(serde_json::from_slice(&std::fs::read(
            self.out.join(format!("{name}.json")),
        )?)?)
    }

    /// The harness exits by itself after `quit`.
    async fn finish(mut self) -> Result<(), HarnessError> {
        self.input.write_all(b"quit\n").await?;
        let status = tokio::time::timeout(Duration::from_secs(10), self.child.wait())
            .await
            .map_err(|_| harness_error("shell did not exit"))??;
        if !status.success() {
            return Err(harness_error(format!("shell exited with {status}")));
        }
        Ok(())
    }
}

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

fn gateway(launch: &Launch) -> Gateway {
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
