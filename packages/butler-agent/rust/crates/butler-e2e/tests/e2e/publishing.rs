//! Stub-cloud publishing through the Library routes.
#![allow(clippy::unwrap_used, reason = "test assertions")]

use butler_e2e::e2e::{
    HarnessError, fake_butler_cloud::FakeButlerCloud, scenario::Setup, security::AdminClient,
};
use reqwest::Method;
use serde_json::json;
use sha2::{Digest, Sha256};

#[tokio::test]
async fn publishing_01_off_by_default_makes_no_request() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeButlerCloud::start().await?;
    let setup = Setup::new("PUBLISH-01")?.env("BUTLER_CLOUD_API_URL", &fake.url);
    std::fs::create_dir_all(setup.sandbox.data.join("gateways"))?;
    std::fs::write(
        setup.sandbox.data.join("gateways/app.json"),
        json!({"config": {"butlerAccountEnabled": false}}).to_string(),
    )?;
    let s = setup.start().await?;
    let reply = s.gw.post("/library/output-x/publish", json!({})).await?;
    assert_eq!(reply.status, 404);
    assert_eq!(reply.error_code(), Some("butler_account_disabled"));
    let reply = s.gw.get("/publishing").await?;
    assert_eq!(reply.status, 404);
    assert_eq!(reply.error_code(), Some("butler_account_disabled"));
    assert_eq!(fake.seen(), [] as [String; 0]);
    s.finish().await
}

#[tokio::test]
async fn publishing_02_signed_out() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeButlerCloud::start().await?;
    let setup = Setup::new("PUBLISH-02")?.env("BUTLER_CLOUD_API_URL", &fake.url);
    std::fs::create_dir_all(setup.sandbox.data.join("gateways"))?;
    std::fs::write(
        setup.sandbox.data.join("gateways/app.json"),
        json!({"config": {"butlerAccountEnabled": true}}).to_string(),
    )?;
    let s = setup.start().await?;
    let reply = s.gw.get("/publishing").await?;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.data(), &json!({"signed_in": false}));
    let reply = s.gw.post("/library/output-x/publish", json!({})).await?;
    assert_eq!(reply.status, 401);
    assert_eq!(reply.error_code(), Some("butler_account_signed_out"));
    assert_eq!(fake.seen(), [] as [String; 0]);
    s.finish().await
}

#[tokio::test]
async fn publishing_03_publish_update_unpublish() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeButlerCloud::start().await?;
    let setup = Setup::new("PUBLISH-03")?
        .env("BUTLER_CLOUD_API_URL", &fake.url)
        .stub_cassette(crate::browser_outputs::stub::cassette()?);
    std::fs::create_dir_all(setup.sandbox.data.join("gateways"))?;
    std::fs::write(
        setup.sandbox.data.join("gateways/app.json"),
        json!({"config": {"butlerAccountEnabled": true}}).to_string(),
    )?;
    let s = setup.start().await?;
    let app = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let reply = app
        .send(
            Method::POST,
            "/setup/butler-account",
            Some(json!({"action": "verify", "email": "user@example.com", "code": "123456"})),
            &[],
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);

    s.turn("general", "Publish").await?;
    let item = format!("output-{:x}", Sha256::digest(b"general\0site"));
    let item_path = format!("/library/{item}");
    let path = format!("{item_path}/publish");
    let url = "https://pages.test/p/k7m2q9xd4b3hn/";
    let upload_count = || {
        fake.seen()
            .iter()
            .filter(|line| line.starts_with("PUT /v1/pages/k7m2q9xd4b3hn/blobs/"))
            .count()
    };

    let preview = s.gw.get(&path).await?;
    assert_eq!(preview.status, 200, "{}", preview.text);
    assert_eq!(preview.data()["file_count"], 2);
    let reply = s.gw.post(&path, json!({})).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(reply.data()["url"], url);
    assert_eq!(upload_count(), 2);
    assert_eq!(s.gw.get(&item_path).await?.data()["published"]["url"], url);

    s.turn("general", "Fix").await?;
    assert_eq!(s.gw.get(&item_path).await?.data()["published"]["url"], url);
    let reply = s.gw.post(&path, json!({})).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert_eq!(upload_count(), 3);
    let pages = s.gw.get("/publishing/pages").await?;
    assert_eq!(pages.data()["pages"][0]["item_id"], item);

    let reply = s.gw.delete(&path).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    assert!(
        s.gw.get(&item_path)
            .await?
            .data()
            .get("published")
            .is_none()
    );
    assert!(
        fake.seen()
            .contains(&"DELETE /v1/pages/k7m2q9xd4b3hn".to_owned())
    );
    s.finish().await
}
