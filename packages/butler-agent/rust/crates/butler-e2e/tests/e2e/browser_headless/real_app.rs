//! Hidden-host hand-over to a real, in-worktree App (offline/stub only).
#![allow(clippy::unwrap_used, clippy::panic, reason = "test assertions")]
use super::support::{admin, browser_processes, call, electron, hidden_app, open, publish, setup};
use base64::Engine;
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use butler_platform::app_browser::{AppElectron, AppHostProcess};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};

fn launch(s: &Scenario, port: u16) -> Result<AppHostProcess, HarnessError> {
    let (executable, app_dir) = electron();
    let renderer = app_dir.join("../ui/dist");
    assert!(
        renderer.join("index.html").is_file(),
        "build the App UI first"
    );
    let profile = s.sandbox.root.join("user-app-profile");
    std::fs::create_dir_all(&profile)?;
    let args = [
        format!("--remote-debugging-port={port}").into(),
        format!("--user-data-dir={}", profile.display()).into(),
    ];
    let values = [
        ("HOME", s.sandbox.home.display().to_string()),
        ("BUTLER_HOME", s.sandbox.home.display().to_string()),
        ("BUTLER_DATA", s.sandbox.data.display().to_string()),
        (
            "BUTLER_APP_ELECTRON_USER_DATA_DIR",
            profile.display().to_string(),
        ),
        ("BUTLER_APP_RENDERER_DIST", renderer.display().to_string()),
        ("BUTLER_APP_SERVER_URL", s.gw.base.clone()),
        ("BUTLER_APP_SERVER_PORT", s.agent.launch.port.to_string()),
        ("BUTLER_APP_UI_URL", String::new()),
        ("BUTLER_APP_DISABLE_SHELL_REGISTRATION", "1".into()),
        ("BUTLER_SECRET_STORE", "file".into()),
        ("BUTLER_PLATFORM_SYSTEM_SECRETS", "0".into()),
        ("BUTLER_E2E_TIER", "stub".into()),
    ];
    let env: Vec<_> = values.iter().map(|(k, v)| (*k, v.as_str())).collect();
    Ok(butler_platform::app_browser::spawn(
        &AppElectron {
            executable,
            app_dir: Some(app_dir),
        },
        &args,
        &env,
        &s.sandbox.logs.join("user-app.log"),
    )?)
}

async fn renderer_targets(port: u16) -> Result<Vec<Value>, HarnessError> {
    Ok(reqwest::get(format!("http://127.0.0.1:{port}/json/list"))
        .await?
        .json()
        .await?)
}

fn save_logs(s: &Scenario) -> Result<(), HarnessError> {
    if let Some(dir) = std::env::var_os("BUTLER_E2E_BROWSER_EVIDENCE") {
        for (source, name) in [
            (s.sandbox.logs.join("user-app.log"), "user-app.log"),
            (
                s.sandbox.data.join("state/browser/app-host/host.log"),
                "user-launch-host.log",
            ),
        ] {
            if source.is_file() {
                std::fs::copy(source, Path::new(&dir).join(name))?;
            }
        }
    }
    Ok(())
}

async fn wait_for_renderer(s: &Scenario, port: u16) -> Result<Vec<Value>, HarnessError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut last = Vec::new();
    loop {
        if let Ok(targets) = renderer_targets(port).await {
            last = targets;
        }
        if last
            .iter()
            .any(|t| t["type"] == "page" && t["url"] == "app://butler/index.html")
        {
            save_logs(s)?;
            return Ok(last);
        }
        if tokio::time::Instant::now() >= deadline {
            save_logs(s)?;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the user App renderer did not open: {last:?}"
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

pub(super) fn evidence(name: &str, value: &Value) -> Result<(), HarnessError> {
    if let Some(dir) = std::env::var_os("BUTLER_E2E_BROWSER_EVIDENCE") {
        let dir = Path::new(&dir);
        std::fs::create_dir_all(dir)?;
        std::fs::write(
            dir.join(format!("{name}.json")),
            serde_json::to_vec_pretty(value)?,
        )?;
        if let Some(data) = value["image"]["data"].as_str() {
            std::fs::write(
                dir.join(format!("{name}.jpg")),
                base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .map_err(std::io::Error::other)?,
            )?;
        }
    }
    Ok(())
}

async fn pids_gone(commands: &[String]) {
    use butler_platform::process_control::{Liveness, liveness};
    let pids: Vec<u32> = commands
        .iter()
        .map(|command| command.split_whitespace().next().unwrap().parse().unwrap())
        .collect();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while pids.iter().any(|pid| liveness(*pid) != Liveness::Gone) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "owned PIDs remain: {pids:?}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test]
async fn hidden_app_idle_reaps_the_whole_process_tree() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(hidden_app(), "hidden-app backend not selected");
    let s = setup("BROWSER-HIDDEN-IDLE-REAP")?.start().await?;
    let admin = admin(&s);
    let url = publish(&s).await?;
    let opened = open(&admin, "general", &url).await?;
    assert_eq!(opened["status"], "ok", "{opened}");
    let processes = browser_processes(&s.sandbox.data.display().to_string());
    assert!(!processes.is_empty(), "the hidden host runs");
    super::guard::idle_reap(&s).await?;
    pids_gone(&processes).await;
    s.finish().await
}

#[tokio::test]
async fn user_app_launch_takes_over_and_both_process_trees_end() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(hidden_app(), "hidden-app backend not selected");
    butler_e2e::skip_unless!(
        std::env::var("BUTLER_E2E_BROWSER_APP_SMOKE").as_deref() == Ok("1"),
        "real App smoke not selected"
    );
    let s = setup("BROWSER-HIDDEN-USER-LAUNCH")?
        .data_folder_token()
        .start()
        .await?;
    let admin = admin(&s);
    let url = publish(&s).await?;
    let hidden = open(&admin, "general", &url).await?;
    assert_eq!(hidden["status"], "ok", "{hidden}");
    let marker = s.sandbox.data.display().to_string();
    let host = browser_processes(&marker);
    assert!(
        !host.is_empty(),
        "the hidden host must run before user launch"
    );
    let observed = call(
        &admin,
        "general",
        "tab.observe",
        &hidden["tab"],
        json!({"include_image":true}),
    )
    .await?;
    assert_eq!(observed["status"], "ok", "{observed}");
    evidence("hidden-observation", &observed)?;
    let socket = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = socket.local_addr()?.port();
    drop(socket);
    let started = tokio::time::Instant::now();
    let app = launch(&s, port)?;
    let targets = wait_for_renderer(&s, port).await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while !browser_processes(&marker).is_empty() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "hidden host did not hand over"
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    pids_gone(&host).await;
    let handover_ms = started.elapsed().as_millis();
    let moved = call(&admin, "general", "tab.observe", &hidden["tab"], json!({})).await?;
    assert_eq!(moved["reason"], "not_your_tab", "{moved}");
    let visible = open(&admin, "general", &url).await?;
    assert_eq!(visible["status"], "ok", "{visible}");
    let pages = renderer_targets(port).await?;
    assert_eq!(
        pages
            .iter()
            .filter(|t| t["type"] == "page" && t["url"] == url)
            .count(),
        1,
        "the real App owns the new tab"
    );
    assert!(
        browser_processes(&marker).is_empty(),
        "no hidden host restarted"
    );
    let profile = s
        .sandbox
        .root
        .join("user-app-profile")
        .display()
        .to_string();
    let executable = electron()
        .0
        .file_stem()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let owned = butler_platform::browser_process::matching_processes(&executable, &profile)?;
    assert!(!owned.is_empty(), "the user App runs");
    let app_pid = app.pid();
    app.kill().await;
    pids_gone(&owned).await;
    let remaining = butler_platform::browser_process::matching_processes(&executable, &profile)?;
    assert!(
        remaining.is_empty(),
        "App helpers left after Job/process group cleanup: {remaining:?}"
    );
    evidence(
        "user-app-handover",
        &json!({"hidden_before":host,"hidden_after":browser_processes(&marker),"handover_ms":handover_ms,"app_pid":app_pid,"app_before_cleanup":owned,"app_after_cleanup":remaining,"renderer_targets":targets,"tab":visible["tab"]}),
    )?;
    s.finish().await
}
