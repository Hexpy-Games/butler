use std::fs;
use std::path::PathBuf;

use serde_json::Value;

use super::super::{NativeProjectLedger, ProjectLedgerBinding, ProjectWorkPlanRead};

/// One source-authored publication, including its actual occurrence receipts.
/// Generate it in an isolated directory with the source oracle before running.
#[tokio::test]
#[ignore = "requires BUTLER_DASHBOARD_ORACLE_DIR from isolated source publication"]
async fn source_managed_dashboard_matches_native_public_reader() {
    let isolated = PathBuf::from(
        std::env::var_os("BUTLER_DASHBOARD_ORACLE_DIR")
            .expect("set BUTLER_DASHBOARD_ORACLE_DIR to the isolated source fixture"),
    );
    let oracle: Value =
        serde_json::from_slice(&fs::read(isolated.join("oracle.json")).unwrap()).unwrap();
    let native = NativeProjectLedger::new(&isolated.join("data"), 1);
    let binding = ProjectLedgerBinding {
        app_project_id: "demo".into(),
        ledger_project_id: "demo".into(),
    };
    let snapshot = native.dashboard_snapshot(binding.clone()).await.unwrap();
    assert_eq!(
        snapshot.revision,
        oracle["snapshotRevision"].as_str().unwrap()
    );

    for (kind, id_key) in [("work", "workId"), ("plan", "planId")] {
        let expected = &oracle[kind];
        let source = native
            .read_dashboard_source(
                binding.clone(),
                kind.into(),
                oracle[id_key].as_str().unwrap().into(),
                snapshot.revision.clone(),
            )
            .await
            .unwrap();
        assert_eq!(source.title, expected["title"].as_str().unwrap());
        assert_eq!(source.body, expected["body"].as_str().unwrap());
        assert_eq!(source.revision, expected["revision"].as_str().unwrap());
        assert_eq!(source.updated_at, expected["updatedAt"].as_str().unwrap());
        assert_eq!(source.status, expected["status"].as_str().unwrap());
    }

    let history = native
        .dashboard_work_history_for_revision(
            binding.clone(),
            snapshot.revision.clone(),
            Some(oracle["workId"].as_str().unwrap().into()),
        )
        .await
        .unwrap();
    assert_eq!(history.len(), 1);
    let expected = &oracle["reference"];
    let entry = &history[0];
    assert_eq!(entry.id, expected["id"].as_str().unwrap());
    assert_eq!(entry.body, expected["body"].as_str().unwrap());
    assert_eq!(entry.revision, expected["revision"].as_str().unwrap());
    assert_eq!(entry.at, expected["at"].as_str().unwrap());
    assert_eq!(entry.status, expected["status"].as_str().unwrap());
    let source = native
        .read_dashboard_source(
            binding,
            "reference".into(),
            entry.id.clone(),
            entry.revision.clone(),
        )
        .await
        .unwrap();
    assert_eq!(
        source.body,
        format!("```json\n{}\n```", expected["body"].as_str().unwrap())
    );
    let plan = native
        .read_project_work_plan(ProjectWorkPlanRead {
            app_project_id: "demo".into(),
            ledger_project_id: "demo".into(),
            work_id: oracle["workId"].as_str().unwrap().into(),
        })
        .await
        .unwrap()
        .unwrap();
    assert!(!plan.approved);
    assert_eq!(plan.action_keys, ["one"]);
    assert!(plan.completed_action_keys.is_empty());
    // Import revisions depend on this exact source fingerprint, including storage bytes.
    let expected_head: Value =
        serde_json::from_slice(&fs::read(isolated.join("source-head-oracle.json")).unwrap())
            .unwrap();
    let project_root = isolated.join("data/project-ledger/projects/demo");
    let head = native
        .run(move |_, collation| super::super::source_head::observe(&project_root, collation))
        .await
        .unwrap();
    assert_eq!(
        head.project_root.to_string_lossy(),
        expected_head["projectRoot"].as_str().unwrap()
    );
    assert_eq!(
        head.source_sha256,
        expected_head["sourceSha256"].as_str().unwrap()
    );
    assert_eq!(
        head.source_file_count as u64,
        expected_head["sourceFileCount"].as_u64().unwrap()
    );
    assert_eq!(
        head.storage_sha256,
        expected_head["storageSha256"].as_str().unwrap()
    );
    assert_eq!(
        head.storage_entry_count as u64,
        expected_head["storageEntryCount"].as_u64().unwrap()
    );
    native.close().await;
}
