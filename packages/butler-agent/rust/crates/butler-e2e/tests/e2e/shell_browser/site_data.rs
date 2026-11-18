//! Site data a page set survives the App's Quit.
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
    use std::sync::{Arc, Mutex};
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    butler_e2e::skip_unless!(
        nonempty("BUTLER_CEF_DIR").is_some(),
        "BUTLER_CEF_DIR is not set"
    );
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new(name)?;
    let _provider = ready_workspace(&sandbox, ChatBehavior::default()).await?;
    // The page reports what it found, then sets the cookie and the storage item if absent.
    let log = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen = log.clone();
    let set = log.clone();
    let pages = axum::Router::new()
        .route("/", axum::routing::get(|| async {
            axum::response::Html("<title>Site data</title><script>const c=encodeURIComponent(document.cookie),s=encodeURIComponent(localStorage.getItem('kept'));fetch('/seen?c='+c+'&s='+s).then(()=>{if(!document.cookie.includes('kept=1'))document.cookie='kept=1; Max-Age=86400; path=/';if(localStorage.getItem('kept')===null)localStorage.setItem('kept','1');return fetch('/set')})</script>")
        }))
        .route("/seen", axum::routing::get(move |axum::extract::RawQuery(query): axum::extract::RawQuery| async move {
            seen.lock().unwrap().push(query.unwrap_or_default());
        }))
        .route("/set", axum::routing::get(move || async move {
            set.lock().unwrap().push("set".into());
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/", listener.local_addr()?);
    let _server = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
        axum::serve(listener, pages).await.unwrap();
    }));
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
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let reports = log.lock().unwrap().clone();
            let reached = if launch == 0 {
                reports.iter().any(|r| r == "set")
            } else {
                reports.len() > seen_before
            };
            assert!(
                tokio::time::Instant::now() < deadline || reached,
                "page did not report: {reports:?}"
            );
            if reached {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        if launch == 0 {
            seen_before = log.lock().unwrap().len();
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
