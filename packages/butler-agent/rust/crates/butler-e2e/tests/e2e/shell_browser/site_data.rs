//! Site data survives Quit and can be cleared through the browser settings.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use butler_e2e::e2e::security::AdminClient;

use super::super::shell_app::gateway;
use super::*;

/// A cookie and localStorage a page set survive the App's Quit: Chromium writes them to the
/// profile only at shutdown or on a delay, and Quit ends the process without dropping anything.
#[tokio::test]
async fn browser_keeps_site_data_across_quit() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    site_data_survives("browser_keeps_site_data_across_quit", false).await
}

/// The same data survives a SIGTERM: it ends the App exactly like the menu Quit.
#[tokio::test]
async fn browser_keeps_site_data_across_terminate() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::process_control::SIGNALS,
        "Windows has no SIGTERM"
    );
    site_data_survives("browser_keeps_site_data_across_terminate", true).await
}

/// Two launches on one data folder: the second finds what the first's page set. The first ends by
/// the menu Quit, or by SIGTERM when `terminate`.
async fn site_data_survives(name: &str, terminate: bool) -> Result<(), HarnessError> {
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    butler_e2e::skip_unless!(
        nonempty("BUTLER_CEF_DIR").is_some(),
        "BUTLER_CEF_DIR is not set"
    );
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new(name)?;
    let _provider = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let log = Arc::new(Mutex::new(Vec::new()));
    let (url, _server) = serve(log.clone()).await?;
    let mut seen_before = 0;
    for launch in 0..2 {
        let mut shell = Shell::start(&sandbox, &[]).await?;
        shell
            .run(&[
                "agent running",
                "wait-anchor composer",
                "browser",
                "wait-anchor browser-area",
                "key secondary-l",
                &format!("type {url}"),
                "key enter",
            ])
            .await?;
        if launch == 0 {
            wait_reports(&log, 2).await;
            seen_before = log.lock().unwrap().len();
        } else {
            wait_reports(&log, seen_before + 1).await;
        }
        if terminate && launch == 0 {
            shell.terminate().await?;
        } else {
            shell.run(&["app-quit"]).await?;
            shell.finish().await?;
        }
    }
    let reports = log.lock().unwrap().clone();
    assert_eq!(reports[0], "c=&s=null", "{reports:?}");
    assert_eq!(reports[seen_before], "c=kept%3D1&s=1", "{reports:?}");
    sandbox.mark_success();
    Ok(())
}

fn reporting_pages(log: Arc<Mutex<Vec<String>>>) -> axum::Router {
    // The page reports what it found, then sets the cookie and the storage item if absent.
    let seen = log.clone();
    let set = log;
    axum::Router::new()
        .route("/", axum::routing::get(|| async {
            axum::response::Html("<title>Site data</title><script>const c=encodeURIComponent(document.cookie),s=encodeURIComponent(localStorage.getItem('kept'));fetch('/seen?c='+c+'&s='+s).then(()=>{if(!document.cookie.includes('kept=1'))document.cookie='kept=1; Max-Age=86400; path=/';if(localStorage.getItem('kept')===null)localStorage.setItem('kept','1');return fetch('/set')})</script>")
        }))
        .route("/seen", axum::routing::get(move |axum::extract::RawQuery(query): axum::extract::RawQuery| async move {
            seen.lock().unwrap().push(query.unwrap_or_default());
        }))
        .route("/set", axum::routing::get(move || async move {
            set.lock().unwrap().push("set".into());
        }))
}

async fn serve(
    log: Arc<Mutex<Vec<String>>>,
) -> Result<(String, tokio_util::task::AbortOnDropHandle<()>), HarnessError> {
    let pages = reporting_pages(log);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/", listener.local_addr()?);
    let server = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
        axum::serve(listener, pages).await.unwrap();
    }));
    Ok((url, server))
}

async fn load(shell: &mut Shell, url: &str) -> Result<(), HarnessError> {
    shell
        .run(&[
            "browser",
            "wait-anchor browser-area",
            "click browser-address",
            "key secondary-l",
            &format!("type {url}"),
            "key enter",
        ])
        .await
}

async fn wait_reports(log: &Mutex<Vec<String>>, n: usize) -> Vec<String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let reports = log.lock().unwrap().clone();
        if reports.len() >= n {
            return reports;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "page did not report: {reports:?}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn report_after(log: &Mutex<Vec<String>>, n: usize) -> Option<String> {
    log.lock()
        .unwrap()
        .iter()
        .skip(n)
        .find(|report| report.starts_with("c="))
        .cloned()
}

/// SHELL-APP-28 — Clear site data removes a history origin's cookie and localStorage.
#[tokio::test]
async fn browser_clears_site_data() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    butler_e2e::skip_unless!(
        nonempty("BUTLER_CEF_DIR").is_some(),
        "BUTLER_CEF_DIR is not set"
    );
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-28-clear-site-data")?;
    let _provider = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let log = Arc::new(Mutex::new(Vec::new()));
    let (url, _server) = serve(log.clone()).await?;
    let other_log = Arc::new(Mutex::new(Vec::new()));
    let (other_url, _other_server) = serve(other_log.clone()).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&[
            "agent running",
            "wait-anchor composer",
            "size 1200 1800",
            "wait 600",
        ])
        .await?;
    load(&mut shell, &url).await?;
    let reports = wait_reports(&log, 2).await;
    assert_eq!(reports[1], "set", "{reports:?}");
    load(&mut shell, &other_url).await?;
    wait_reports(&other_log, 2).await;
    shell
        .run(&[
            "click sidebar-settings",
            "wait-anchor settings-nav-browser",
            "click settings-nav-browser",
            "wait-anchor browser-site-data-clear",
            "click browser-site-data-clear",
            "wait-anchor settings-confirm-accept",
            "expect-toasts 0",
            "click settings-confirm-accept",
            "wait-anchor toasts:1",
            "click settings-back",
            "wait-no-anchor settings",
        ])
        .await?;
    let n = log.lock().unwrap().len();
    load(&mut shell, &url).await?;
    let reports = wait_reports(&log, n + 1).await;
    assert_eq!(
        report_after(&log, n).as_deref(),
        Some("c=&s=null"),
        "{reports:?}"
    );
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}

/// SHELL-APP-28 — Sign out of this site removes the cookie and keeps localStorage on the open port.
#[tokio::test]
async fn browser_signs_out_of_a_site() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    butler_e2e::skip_unless!(
        nonempty("BUTLER_CEF_DIR").is_some(),
        "BUTLER_CEF_DIR is not set"
    );
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-28-sign-out-site")?;
    let _provider = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    let log = Arc::new(Mutex::new(Vec::new()));
    let (url, _server) = serve(log.clone()).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&[
            "agent running",
            "wait-anchor composer",
            "size 1200 1800",
            "wait 600",
        ])
        .await?;
    load(&mut shell, &url).await?;
    let reports = wait_reports(&log, 2).await;
    assert_eq!(reports[1], "set", "{reports:?}");
    let admin = AdminClient::new(
        gateway(&shell.launch),
        shell.launch.admin_credential().unwrap(),
    );
    let response = admin
        .send(
            reqwest::Method::POST,
            "/security/signins/site",
            Some(serde_json::json!({"site": "127.0.0.1", "all_conversations": true})),
            &[],
        )
        .await?;
    assert_eq!(response.status, 200, "{}", response.text);
    shell
        .run(&[
            "click sidebar-settings",
            "wait-anchor settings-nav-browser",
            "click settings-nav-browser",
            "wait-anchor sign-in-menu-127.0.0.1",
            "click sign-in-menu-127.0.0.1",
            "wait-anchor sign-in-menu-127.0.0.1-item-0-0",
            "expect-toasts 0",
            "click sign-in-menu-127.0.0.1-item-0-0",
            "wait-anchor toasts:1",
            "click settings-back",
            "wait-no-anchor settings",
        ])
        .await?;
    let n = log.lock().unwrap().len();
    load(&mut shell, &url).await?;
    let reports = wait_reports(&log, n + 1).await;
    assert_eq!(
        report_after(&log, n).as_deref(),
        Some("c=&s=1"),
        "{reports:?}"
    );
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
