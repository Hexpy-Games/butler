//! Guided CSV: new-file watching, exact deletion, multiple accounts and undo.
use super::{
    fill::{Cleanup, keychain_opt_in, keychain_scenario},
    host::admin,
};
use butler_e2e::e2e::{HarnessError, security::AdminClient};
use reqwest::Method;
use serde_json::{Value, json};

const CANARY: &str = "canary-export-4b2ec9";
async fn post(a: &AdminClient, op: &str, body: Value) -> Result<Value, HarnessError> {
    let r = a
        .send(
            Method::POST,
            &format!("/security/browser-import/{op}"),
            Some(body),
            &[],
        )
        .await?;
    assert_eq!(r.status, 200, "{op}: {}", r.text);
    Ok(r.data().clone())
}
#[tokio::test]
async fn guided_csv_new_export_delete_idempotency_and_undo() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        keychain_opt_in(),
        "isolated system-store test opt-in required"
    );
    let s = keychain_scenario("BROWSER-IMPORT-GUIDED-CSV").await?;
    let a = admin(&s);
    let mut cleanup = Cleanup::new(&a);
    let downloads = s.sandbox.home.join("Downloads");
    std::fs::create_dir_all(&downloads)?;
    let csv = format!(
        "url,username,password\nhttps://login.fixture-export.test,one,{CANARY}\nhttps://login.fixture-export.test,two,{CANARY}\n"
    );
    let old = downloads.join("old.csv");
    std::fs::write(&old, &csv)?;
    let watch = post(
        &a,
        "export",
        json!({"source":"chrome:fixture","open":false}),
    )
    .await?;
    assert_eq!(
        post(&a, "export/poll", json!({"export_id":watch["export_id"]})).await?["waiting"],
        true
    );
    std::fs::write(downloads.join("unrelated.csv"), "item,count\nbook,2\n")?;
    assert_eq!(
        post(&a, "export/poll", json!({"export_id":watch["export_id"]})).await?["waiting"],
        true
    );
    let path = downloads.join("new.csv");
    std::fs::write(&path, &csv)?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
    let imported = loop {
        let reply = post(&a, "export/poll", json!({"export_id":watch["export_id"]})).await?;
        if reply["waiting"] != true {
            break reply;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "new CSV notification"
        );
    };
    let rows = a.send(Method::GET, "/security/signins", None, &[]).await?;
    for row in rows.data()["sites"].as_array().unwrap() {
        cleanup.track(row["entry"]["id"].as_str().unwrap());
        assert_eq!(row["entry"]["policy"], "ask");
    }
    assert_eq!(
        imported["passwords"], 2,
        "accounts are distinct by origin and username"
    );
    assert_eq!(rows.data()["sites"].as_array().unwrap().len(), 2);
    assert_eq!(imported["invalid"], 0);
    let again = post(
        &a,
        "start",
        json!({"source":"file","bookmarks":false,"passwords":true,"passwords_path":path}),
    )
    .await?;
    assert_eq!(again["passwords"], 0);
    assert_eq!(again["updated"], 0);
    assert_eq!(again["existing"], 2);
    assert_eq!(
        post(&a, "undo", json!({"run_id":again["run_id"]})).await?["passwords"],
        0
    );
    std::fs::write(&path, "unrelated file")?;
    let changed = a
        .send(
            Method::POST,
            "/security/browser-import/export/delete",
            Some(json!({"export_id":watch["export_id"]})),
            &[],
        )
        .await?;
    assert_eq!(changed.status, 422);
    assert!(path.is_file());
    std::fs::write(&path, &csv)?;
    assert_eq!(
        post(&a, "export/delete", json!({"export_id":watch["export_id"]})).await?["deleted"],
        true
    );
    assert!(!path.exists());
    assert!(old.is_file());
    assert_eq!(
        post(&a, "undo", json!({"run_id":imported["run_id"]})).await?["passwords"],
        2
    );
    super::canary_absent(&s.sandbox.data, CANARY, &s.agent.logs());
    drop(cleanup);
    s.finish().await
}
