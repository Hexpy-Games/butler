use super::*;
use butler_e2e::e2e::{gateway_proxy::GatewayProxy, scenario::Setup};

/// SHELL-APP-27 — A browser import the gateway answers with primary_password_required asks for
/// the primary password in a masked field; Enter and Import resend it, a wrong one shows the
/// error, the right one finishes.
#[tokio::test]
async fn shell_app_27_browser_import_asks_for_the_primary_password() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut s = Setup::new("SHELL-APP-27")?
        .data_folder_token()
        .env("BUTLER_APP_SERVER_PORT", "0")
        .start()
        .await?;
    live_turns::complete_onboarding(&s.gw).await?;
    let proxy = GatewayProxy::start(s.gw.base.clone()).await?;
    proxy.override_route(
        "GET",
        "/security/signins",
        200,
        json!({"data": {"available": true, "sites": []}}),
    );
    proxy.override_route(
        "GET",
        "/security/browser-import/sources",
        200,
        json!({"data": {"sources": [{"key": "chrome-default", "browser": "chrome", "name": "Default"}]}}),
    );
    for code in ["primary_password_required", "incorrect_primary_password"] {
        proxy.override_route(
            "POST",
            "/security/browser-import/start",
            422,
            json!({"error": {"code": code, "message": "x"}}),
        );
    }
    proxy.override_route(
        "POST",
        "/security/browser-import/start",
        200,
        json!({"data": {
            "bookmarks": 1, "existing": 0, "passwords": 1, "updated": 0, "invalid": 0,
            "history": 0, "run_id": "run-1", "needs_csv": false, "csv_required": 0
        }}),
    );
    proxy.attach(&s.sandbox.data).await?;
    let mut shell = Shell::attach(&s, &[]).await?;
    shell
        .run(&[
            "connected",
            "size 1280 2400",
            "click sidebar-settings",
            "wait-anchor settings-nav-browser",
            "click settings-nav-browser",
            "wait-anchor browser-import-open",
            "click browser-import-open",
            "wait-anchor browser-import-next",
            "click browser-import-next",
            "wait-anchor browser-import-run",
            "click browser-import-run",
            "wait-anchor browser-import-primary",
            "click browser-import-primary",
            "type wrong-pass",
            "key enter",
            "wait-anchor browser-import-primary-wrong",
            "click browser-import-primary",
            "type right-pass",
            "wait-anchor browser-import-primary-run",
            "click browser-import-primary-run",
            "wait-anchor browser-import-finish",
            "expect-no-anchor browser-import-primary",
        ])
        .await?;

    let starts = proxy.requests("/security/browser-import/start");
    assert_eq!(starts.len(), 3);
    assert_eq!(starts[0]["source"], "chrome-default");
    assert!(starts[0].get("primary_password").is_none());
    assert_eq!(starts[1]["primary_password"], "wrong-pass");
    assert_eq!(starts[2]["primary_password"], "right-pass");

    shell.finish().await?;
    s.agent.terminate().await?;
    s.finish().await
}
