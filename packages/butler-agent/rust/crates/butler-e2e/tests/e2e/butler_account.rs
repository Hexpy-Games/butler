//! Butler account routes against a local stub, with local admin credentials.
#![allow(clippy::unwrap_used, reason = "test assertions")]

use butler_e2e::e2e::{
    HarnessError, fake_butler_cloud::FakeButlerCloud, scenario::Setup, security::AdminClient,
};
use reqwest::Method;
use serde_json::json;

#[tokio::test]
async fn butler_account_01_off_by_default_makes_no_request() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeButlerCloud::start().await?;
    let s = Setup::new("ACCT-01")?
        .env("BUTLER_CLOUD_API_URL", &fake.url)
        .start()
        .await?;
    let app = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let reply = app
        .send(Method::GET, "/setup/butler-account", None, &[])
        .await?;
    assert_eq!(reply.status, 404);
    assert_eq!(reply.error_code(), Some("butler_account_disabled"));
    let reply = app
        .send(
            Method::POST,
            "/setup/butler-account",
            Some(json!({"action": "start", "email": "user@example.com"})),
            &[],
        )
        .await?;
    assert_eq!(reply.status, 404);
    assert_eq!(reply.error_code(), Some("butler_account_disabled"));
    let reply = app
        .send(Method::GET, "/setup/butler-backup", None, &[])
        .await?;
    assert_eq!(reply.status, 404);
    assert_eq!(reply.error_code(), Some("butler_account_disabled"));
    let reply = app
        .send(Method::GET, "/setup/canon-online", None, &[])
        .await?;
    assert_eq!(reply.status, 404);
    assert_eq!(reply.error_code(), Some("butler_account_disabled"));
    assert_eq!(
        fake.seen(),
        Vec::<String>::new(),
        "the off feature made a request"
    );
    s.finish().await
}

#[tokio::test]
async fn butler_account_02_sign_in_plan_devices_sign_out() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeButlerCloud::start().await?;
    let setup = Setup::new("ACCT-02")?.env("BUTLER_CLOUD_API_URL", &fake.url);
    std::fs::create_dir_all(setup.sandbox.data.join("gateways"))?;
    std::fs::write(
        setup.sandbox.data.join("gateways/app.json"),
        json!({"config": {"butlerAccountEnabled": true}}).to_string(),
    )?;
    let s = setup.start().await?;
    let app = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let path = "/setup/butler-account";
    let reply = app.send(Method::GET, path, None, &[]).await?;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.data()["signed_in"], false);
    let reply = app
        .send(
            Method::POST,
            path,
            Some(json!({"action": "start", "email": "user@example.com"})),
            &[],
        )
        .await?;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.data()["sent"], true);
    let reply = app
        .send(
            Method::POST,
            path,
            Some(json!({"action": "verify", "email": "user@example.com", "code": "000000"})),
            &[],
        )
        .await?;
    assert_eq!(reply.status, 400);
    assert_eq!(reply.error_code(), Some("code_invalid"));
    let reply = app
        .send(
            Method::POST,
            path,
            Some(json!({"action": "verify", "email": "user@example.com", "code": "123456"})),
            &[],
        )
        .await?;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.data()["signed_in"], true);
    assert_eq!(reply.data()["entitlements"]["plan"], "free");
    let file = s.sandbox.data.join("auth/butler-account.json");
    assert!(file.exists());
    let reply = app
        .send(Method::GET, "/setup/butler-account/devices", None, &[])
        .await?;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.data()["devices"].as_array().unwrap().len(), 2);
    fake.set_plan("plus");
    let reply = app.send(Method::GET, path, None, &[]).await?;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.data()["entitlements"]["plan"], "plus");
    let reply = app
        .send(
            Method::DELETE,
            "/setup/butler-account/devices/dev_other",
            None,
            &[],
        )
        .await?;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.data()["revoked"], true);
    let reply = app.send(Method::DELETE, path, None, &[]).await?;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.data()["signed_in"], false);
    assert!(!file.exists());
    assert!(fake.seen().contains(&"POST /v1/auth/sign-out".to_owned()));
    s.finish().await
}
