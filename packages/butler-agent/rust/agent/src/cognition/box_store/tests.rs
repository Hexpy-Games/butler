use std::{fs, path::Path, sync::Arc};

use rusqlite::Connection;
use serde_json::{Value, json};

use crate::{
    cognition::CognitionPathEnvironment,
    coordination::{
        CognitionCoordinationHost, CognitionProcessStatus, CognitionWriteCoordinator,
        CoordinationResult,
    },
};

use super::BoxStoreService;

const NOW: &str = "2026-09-23T00:00:00.000Z";

struct TestHost;

impl CognitionCoordinationHost for TestHost {
    fn process_id(&self) -> u32 {
        std::process::id()
    }
    fn hostname(&self) -> CoordinationResult<String> {
        Ok("box-store-test".into())
    }
    fn process_status(&self, _pid: u64) -> CognitionProcessStatus {
        CognitionProcessStatus::Alive
    }
    fn new_uuid(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
    fn now_epoch_millis(&self) -> i64 {
        crate::js_date::parse_iso_millis(NOW).unwrap()
    }
    fn now_iso(&self) -> String {
        NOW.into()
    }
}

fn service(root: &Path) -> BoxStoreService {
    BoxStoreService::new(
        root.to_path_buf(),
        CognitionPathEnvironment::default(),
        Arc::new(CognitionWriteCoordinator::new(Arc::new(TestHost)).unwrap()),
    )
}

fn manifest(id: &str, expires_at: Option<&str>, files: &Value) -> Value {
    json!({
        "schema": "butler.cognition.box.item.v1",
        "box_item_id": id,
        "collection_id": null,
        "kind": "file",
        "status": "indexed",
        "created_at": NOW,
        "captured_at": NOW,
        "updated_at": NOW,
        "title": id,
        "summary": "summary",
        "tags": ["sample"],
        "origin": {
            "producer": "test", "session_id": "session-1", "turn_id": null,
            "message_id": null, "tool_call_id": null, "worker_run_id": null,
            "consolidation_run_id": null
        },
        "source": {"uri": null, "local_path": null, "provider": null, "fetched_at": null, "observed_at": null},
        "files": files,
        "privacy": {"class": "private", "external_provider_allowed": false, "reason": "test"},
        "retention": {"class": "working", "pinned": false, "expires_at": expires_at},
        "freshness": {"class": "unknown", "source_timestamp": null, "checked_at": null, "expires_at": null},
        "refs": {
            "memory_chunk_ids": ["chunk-1"], "feedback_ids": ["feedback-1"],
            "knowhow_ids": ["knowhow-1"], "graph_edge_ids": ["edge-1"],
            "parent_box_item_id": null
        },
        "quality": {"score": 0.8, "signals": ["captured"], "custom_quality": {"keep": true}},
        "citations": ["citation-1"],
        "provenance": ["test"],
        "custom_metadata": {"keep": true}
    })
}

fn file_ref(ownership: &str, relative: Option<&str>) -> Value {
    json!({
        "role": "primary", "path": null, "box_relative_path": relative,
        "ownership": ownership, "size_bytes": 4, "sha256": "abcd",
        "mime_type": "text/plain", "mtime": NOW
    })
}

fn write_manifest(root: &Path, id: &str, value: &Value) -> std::path::PathBuf {
    let directory = root.join("cognition/box/items").join(id);
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join("manifest.json");
    fs::write(&path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
    path
}

fn temp_root(prefix: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "{prefix}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ))
}

#[tokio::test]
async fn index_rebuild_reports_skips_and_count_rebuilds_only_when_missing() {
    let root = temp_root("butler-box-index");
    let valid = manifest(
        "box_valid",
        None,
        &json!([file_ref("box-owned", Some("content/main.txt"))]),
    );
    write_manifest(&root, "box_valid", &valid);
    write_manifest(&root, "box_invalid", &json!({"schema": "older"}));
    let malformed_path = write_manifest(&root, "box_malformed", &json!({}));
    fs::write(&malformed_path, "{").unwrap();
    fs::create_dir_all(root.join("cognition/box/items/box_no_manifest")).unwrap();

    let service = service(&root);
    assert!(service.manifest_exists("box_invalid").await.unwrap());
    assert!(!service.manifest_exists("box_missing").await.unwrap());
    assert_eq!(
        service
            .manifest_exists("box_malformed")
            .await
            .unwrap_err()
            .code,
        "memory_box_manifest_invalid"
    );
    let report = service.rebuild_index().await.unwrap();
    assert_eq!(report.status, "partial");
    assert_eq!(report.indexed_count, 1);
    assert_eq!(report.skipped_count, 2);
    assert_eq!(service.count_indexed().await.unwrap(), 1);

    let index = root.join("cognition/box/index.sqlite");
    let database =
        Connection::open_with_flags(&index, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let tables: i64 = database
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('box_items','box_item_files','box_item_origins','box_item_refs','box_item_tags')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tables, 5);
    drop(database);

    fs::remove_file(&index).unwrap();
    assert_eq!(service.count_indexed().await.unwrap(), 1);
    fs::write(&index, "not a SQLite database").unwrap();
    assert_eq!(
        service.count_indexed().await.unwrap_err().code,
        "memory_box_index_invalid"
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn retention_preserves_unknown_data_and_skips_external_or_unexpired_items() {
    let root = temp_root("butler-box-retention");
    let item = root.join("cognition/box/items/box_expired");
    fs::create_dir_all(item.join("content")).unwrap();
    fs::write(item.join("content/main.txt"), "owned").unwrap();
    let mut expired = manifest(
        "box_expired",
        Some("2026-09-22T23:59:59.000Z"),
        &json!([file_ref("box-owned", Some("content/main.txt"))]),
    );
    expired["schema"] = json!("legacy-but-readable");
    write_manifest(&root, "box_expired", &expired);

    let external = root.join("cognition/box/items/box_external");
    fs::create_dir_all(&external).unwrap();
    let user_file = root.join("external-user-file.txt");
    fs::write(&user_file, "keep").unwrap();
    write_manifest(
        &root,
        "box_external",
        &manifest(
            "box_external",
            Some("2026-09-22T23:59:59.000Z"),
            &json!([file_ref(
                "external-user-owned",
                Some("../external-user-file.txt")
            )]),
        ),
    );
    write_manifest(
        &root,
        "box_unexpired_invalid_schema",
        &json!({"schema": "legacy", "retention": {"pinned": false, "expires_at": null}}),
    );
    let mut pinned = manifest("box_pinned", Some("2026-09-22T23:59:59.000Z"), &json!([]));
    pinned["retention"]["pinned"] = json!(true);
    write_manifest(&root, "box_pinned", &pinned);

    let report = service(&root)
        .retention(crate::js_date::parse_iso_millis(NOW).unwrap())
        .await
        .unwrap();
    assert_eq!(report.expired_candidate_count, 2);
    assert_eq!(report.pruned_box_owned_count, 1);
    assert!(!item.join("content/main.txt").exists());
    assert_eq!(fs::read_to_string(user_file).unwrap(), "keep");
    let updated: Value =
        serde_json::from_slice(&fs::read(item.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(updated["status"], "forgotten");
    assert_eq!(updated["updated_at"], NOW);
    assert_eq!(updated["custom_metadata"]["keep"], true);
    assert_eq!(updated["quality"]["custom_quality"]["keep"], true);
    assert!(
        updated["quality"]["signals"]
            .as_array()
            .unwrap()
            .contains(&json!("retention_pruned"))
    );
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn retention_prevalidates_every_path_before_deleting_any_file_in_an_item() {
    let root = temp_root("butler-box-retention-path");
    let item = root.join("cognition/box/items/box_unsafe");
    fs::create_dir_all(item.join("content")).unwrap();
    fs::write(item.join("content/main.txt"), "must survive").unwrap();
    let outside = root.join("outside.txt");
    fs::write(&outside, "outside").unwrap();
    write_manifest(
        &root,
        "box_unsafe",
        &manifest(
            "box_unsafe",
            Some("2026-09-22T23:59:59.000Z"),
            &json!([
                file_ref("box-owned", Some("content/main.txt")),
                file_ref("box-owned", Some("../outside.txt"))
            ]),
        ),
    );

    let error = service(&root)
        .retention(crate::js_date::parse_iso_millis(NOW).unwrap())
        .await
        .unwrap_err();
    assert_eq!(error.code, "memory_box_retention_path_unsafe");
    assert_eq!(
        fs::read_to_string(item.join("content/main.txt")).unwrap(),
        "must survive"
    );
    assert_eq!(fs::read_to_string(outside).unwrap(), "outside");
    let unchanged: Value =
        serde_json::from_slice(&fs::read(item.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(unchanged["status"], "indexed");
    fs::remove_dir_all(root).unwrap();

    #[cfg(unix)]
    {
        let data = temp_root("butler-box-root-escape");
        let outside = temp_root("butler-box-root-outside");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, data.join("cognition")).unwrap();
        let error = service(&data)
            .manifest_exists("box_missing")
            .await
            .unwrap_err();
        assert_eq!(error.code, "memory_box_root_path_unsafe");
        assert!(
            !outside
                .join("consolidation/locks/consolidation.lock")
                .exists()
        );
        assert!(!outside.join("box").exists());
        fs::remove_file(data.join("cognition")).unwrap();
        fs::remove_dir_all(data).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
