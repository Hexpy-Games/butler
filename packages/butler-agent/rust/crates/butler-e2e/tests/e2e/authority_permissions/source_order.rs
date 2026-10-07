//! A grant's latest source is ordered by timestamp, then insertion rowid.
use butler_e2e::e2e::{HarnessError, scenario::Setup};

#[tokio::test]
async fn approvals_keep_latest_source_with_equal_timestamps() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("APPROVALS-SOURCE-ORDER")?.start().await?;
    super::seed::seed(s.sandbox.data.clone(), 3, false).await?;
    let db = butler_platform::sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    db.execute_batch(
        "CREATE TEMP TABLE grant_copy AS SELECT * FROM btcc_conversation_permissions WHERE grant_ref=(SELECT grant_ref FROM btcc_conversation_permissions WHERE owner_session_id='butler/app-chat-0');
         UPDATE grant_copy SET grant_ref='opaque-ref';
         INSERT INTO btcc_conversation_permissions SELECT * FROM grant_copy;
         DROP TABLE grant_copy;",
    )?;
    let before = s.gw.get("/authority-permissions").await?;
    assert_eq!(before.status, 200);
    let opaque = before.data()["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|grant| grant["grant_ref"] == "opaque-ref")
        .unwrap();
    assert_eq!(opaque["target"], "");
    assert_eq!(opaque["capability"], "");
    assert!(opaque["cwd"].is_null());
    // Reverse the capability's index order relative to insertion order.
    db.execute_batch(
        "CREATE TEMP TABLE source_copy AS SELECT * FROM btcc_authority_requests WHERE request_id='request-0';
         UPDATE btcc_authority_requests SET capability='run_command_remote_observation' WHERE request_id='request-0';
         UPDATE source_copy SET request_id='later-source',request_ref='later-source',identity_sha256='later-source',schedule_client_message_id='later-source';
         INSERT INTO btcc_authority_requests SELECT * FROM source_copy;
         DROP TABLE source_copy;",
    )?;
    let same_time = s.gw.get("/authority-permissions").await?;
    assert_eq!(same_time.status, 200);
    assert_eq!(
        same_time.data()["permissions"],
        before.data()["permissions"]
    );
    db.execute(
        "UPDATE btcc_authority_requests SET created_at='2099-01-01T00:00:00Z' WHERE request_id='request-0'",
        [],
    )?;
    let latest = s.gw.get("/authority-permissions").await?;
    assert_eq!(latest.status, 200);
    let mut expected = before.data()["permissions"].clone();
    for grant in expected.as_array_mut().unwrap() {
        if grant["grant_ref"] == super::seed::reference(0) {
            grant["capability"] = "run_command_remote_observation".into();
        }
    }
    assert_eq!(latest.data()["permissions"], expected);
    // Same rowid with changed decoding input must invalidate memoized facts.
    db.execute("UPDATE btcc_authority_requests SET normalized_input_json=json_set(normalized_input_json,'$.command','a different command') WHERE request_id='request-0'", [])?;
    let changed = s.gw.get("/authority-permissions").await?;
    assert_eq!(changed.status, 200);
    assert_eq!(changed.data()["permissions"], before.data()["permissions"]);
    db.execute("UPDATE btcc_authority_requests SET normalized_input_json=(SELECT normalized_input_json FROM btcc_authority_requests WHERE request_id='later-source') WHERE request_id='request-0'", [])?;
    // A source larger than the cache budget still returns identical content.
    db.execute("UPDATE btcc_authority_requests SET normalized_input_json=json_set(normalized_input_json,'$.padding',printf('%04200000d',1)) WHERE request_id='request-0'", [])?;
    for _ in 0..2 {
        let uncached = s.gw.get("/authority-permissions").await?;
        assert_eq!(uncached.status, 200);
        assert_eq!(uncached.data()["permissions"], expected);
    }
    drop(db);
    s.finish().await
}
