//! Real App browser executor in an isolated Electron, backed only by snapshots.
use super::{fixture::Task, live_proxy::Proxy};
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use butler_platform::app_browser::{AppElectron, AppHostProcess};
use serde_json::json;
use std::{path::PathBuf, sync::Arc, time::Duration};

pub(super) async fn start(
    s: &Scenario,
    task: &Arc<Task>,
    proxy: &Proxy,
) -> Result<AppHostProcess, HarnessError> {
    let executable = std::env::var_os("BUTLER_E2E_ELECTRON")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .ok_or_else(|| HarnessError("BUTLER_E2E_ELECTRON must name a test Electron".into()))?;
    let executable = tokio::fs::canonicalize(executable).await?;
    let root = s.sandbox.root.join("snapshot-app");
    tokio::fs::create_dir_all(root.join("profile")).await?;
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/e2e/research_eval");
    let app = butler_e2e::e2e::binary::workspace_root().join("../../butler-app/client/electron");
    let bytes = serde_json::to_vec(&json!({
        "gateway":s.gw.base,"proxy":proxy.base,"sink":proxy.sink,"pages":task.pages,
        "profile":root.join("profile"),"stills":root.join("stills"),"app":app
    }))?;
    if let Ok(key) = std::env::var("DEEPSEEK_API_KEY")
        && !key.is_empty()
        && bytes.windows(key.len()).any(|w| w == key.as_bytes())
    {
        return Err(HarnessError(
            "credential found in snapshot configuration".into(),
        ));
    }
    let config = root.join("config.json");
    tokio::fs::write(&config, bytes).await?;
    let values = [
        ("HOME", s.sandbox.home.display().to_string()),
        ("BUTLER_DATA", s.sandbox.data.display().to_string()),
        ("BUTLER_RESEARCH_HOST_TOKEN", s.gw.token.clone()),
        (
            "BUTLER_RESEARCH_HOST_ADMIN",
            s.agent.launch.admin_credential().unwrap(),
        ),
        ("DEEPSEEK_API_KEY", String::new()),
    ];
    let env: Vec<_> = values.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let mut browser = butler_platform::app_browser::spawn(
        &AppElectron {
            executable,
            app_dir: Some(source.join("snapshot_app.mjs")),
        },
        &[config.into_os_string()],
        &env,
        &s.sandbox.logs.join("snapshot-app.log"),
    )?;
    if !attached(proxy, &mut browser).await {
        let mut diagnostic = tokio::fs::read_to_string(s.sandbox.logs.join("snapshot-app.log"))
            .await
            .unwrap_or_default();
        for (name, secret) in &values {
            if name.contains("TOKEN") || name.contains("ADMIN") {
                diagnostic = diagnostic.replace(secret, "[redacted]");
            }
        }
        if let Ok(secret) = std::env::var("DEEPSEEK_API_KEY")
            && !secret.is_empty()
        {
            diagnostic = diagnostic.replace(&secret, "[redacted]");
        }
        return Err(HarnessError(format!(
            "snapshot App host did not attach: {diagnostic}"
        )));
    }
    Ok(browser)
}
async fn attached(proxy: &Proxy, browser: &mut AppHostProcess) -> bool {
    let changed = proxy.traffic.lock().unwrap().changed.clone();
    let ready = async {
        loop {
            let notified = changed.notified();
            if proxy.traffic.lock().unwrap().host_ready {
                break;
            }
            notified.await;
        }
    };
    tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(20), ready) => result.is_ok(),
        () = browser.wait() => false,
    }
}
