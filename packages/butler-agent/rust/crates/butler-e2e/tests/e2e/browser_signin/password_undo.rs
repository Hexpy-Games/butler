//! Public import, restart and fill proof for newer-only updates and secret undo.
use super::{host::admin, native_import::assert_password, vault::vault_scenario};
use butler_e2e::e2e::{HarnessError, security::AdminClient};
use reqwest::Method;
use serde_json::{Value, json};
const OLD: &str = "canary-previous-import-382";
const NEW: &str = "canary-newer-import-473";
async fn post(a: &AdminClient, op: &str, body: Value) -> Result<Value, HarnessError> {
    let reply = a
        .send(
            Method::POST,
            &format!("/security/browser-import/{op}"),
            Some(body),
            &[],
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data().clone())
}
#[tokio::test]
async fn newer_password_update_and_restart_undo_restore_keychain_secret() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        super::fill::keychain_opt_in(),
        "isolated system-store opt-in required"
    );
    let mut s = vault_scenario("BROWSER-IMPORT-PASSWORD-UNDO", None).await?;
    let a = admin(&s);
    let path = s.sandbox.home.join("passwords.csv");
    let write = |secret: &str, time: Option<i64>| -> Result<(), HarnessError> {
        let header = if time.is_some() {
            ",timePasswordChanged"
        } else {
            ""
        };
        let value = time.map(|t| format!(",{t}")).unwrap_or_default();
        std::fs::write(
            &path,
            format!(
                "url,username,password{header}\nhttps://login.undo-fixture.test,user,{secret}{value}\n"
            ),
        )?;
        Ok(())
    };
    let body = json!({"source":"file","bookmarks":false,"passwords":true,"passwords_path":path});
    write(OLD, Some(1_700_000_000_000))?;
    let original = post(&a, "start", body.clone()).await?;
    assert_eq!(original["passwords"], 1);
    let view = a.send(Method::GET, "/security/signins", None, &[]).await?;
    let entry = view.data()["sites"][0]["entry"].clone();
    let mut cleanup = super::fill::Cleanup::new(&a);
    cleanup.track(entry["id"].as_str().unwrap());
    for time in [None, Some(1_690_000_000_000), Some(1_700_000_000_000)] {
        write(NEW, time)?;
        let skipped = post(&a, "start", body.clone()).await?;
        assert_eq!(skipped["updated"], 0);
        assert_eq!(skipped["existing"], 1);
        assert_password(&s, &entry, OLD).await?;
    }
    // Fill records a current last-used time, so source modification must beat that too.
    let future = chrono::Utc::now().timestamp_millis() + 86_400_000;
    write(NEW, Some(future))?;
    let update = post(&a, "start", body.clone()).await?;
    assert_eq!(update["passwords"], 0);
    assert_eq!(update["updated"], 1);
    assert_password(&s, &entry, NEW).await?;
    s.restart().await?;
    let a = admin(&s);
    let undone = post(&a, "undo", json!({"run_id":update["run_id"]})).await?;
    assert_eq!(undone["passwords"], 0);
    assert_eq!(undone["updated"], 1);
    assert_password(&s, &entry, OLD).await?;
    assert_eq!(
        post(&a, "undo", json!({"run_id":update["run_id"]})).await?["updated"],
        0
    );
    // A later manual change survives undo of the older insertion.
    let saved = a
        .send(
            Method::POST,
            "/security/signins",
            Some(json!({"site":"login.undo-fixture.test","username":"user","password":NEW})),
            &[],
        )
        .await?;
    assert_eq!(saved.status, 200);
    assert_eq!(
        post(&a, "undo", json!({"run_id":original["run_id"]})).await?["passwords"],
        0
    );
    assert_password(&s, &entry, NEW).await?;
    super::canary_absent(&s.sandbox.data, OLD, &s.agent.logs());
    super::canary_absent(&s.sandbox.data, NEW, &s.agent.logs());
    drop(cleanup);
    s.finish().await
}
