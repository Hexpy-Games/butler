use super::*;
use crate::gateway::ArtifactFileCandidate;

struct Clock;
impl AppIdentityClock for Clock {
    fn new_uuid(&self) -> String {
        "11111111-1111-4111-8111-111111111111".into()
    }
    fn now_iso(&self) -> String {
        "2026-09-20T00:00:00.000Z".into()
    }
    fn iso_after_millis(&self, _: u64) -> String {
        self.now_iso()
    }
}

// test-category: race
#[tokio::test]
async fn source_artifact_is_stored_once_with_original_metadata() {
    if let Ok(point) = std::env::var("BUTLER_FILE_TEST_CHILD") {
        interrupted_write(&point).await;
        return;
    }
    interrupted_children();
    let root = std::env::temp_dir().join(format!("butler-app-files-{}", uuid::Uuid::new_v4()));
    let source = root.join("artifacts/public-data/report.MD");
    std::fs::create_dir_all(source.parent().unwrap()).unwrap();
    std::fs::write(&source, b"native artifact\n").unwrap();
    let owner = AppMessageFiles::new(&root.clone(), Arc::new(Clock));
    let candidate = ArtifactFileCandidate {
        candidate_paths: vec![source],
        name: "reports\\Daily:Report.MD".into(),
        mime_type: Some("APPLICATION/OCTET-STREAM".into()),
    };
    let files = owner
        .materialize(ArtifactMaterializationRequest {
            allowed_roots: vec![root.clone()],
            candidates: vec![candidate.clone(), candidate],
            existing_content_keys: Vec::new(),
        })
        .await
        .unwrap();
    assert_eq!(files.len(), 1);
    let file = &files[0];
    assert_eq!(file.safe_name, "Daily_Report.MD");
    assert_eq!(file.mime_type, "application/octet-stream");
    assert_eq!(file.kind, "text");
    assert_eq!(file.size_bytes, 16);
    assert_eq!(
        file.sha256,
        "6c227048ddc712dcb6b6519e44011b8c3e13e4307bd6c12ffbf5e8539405e4fd"
    );
    assert_eq!(
        std::fs::read(
            root.join("app-server/message-files")
                .join(&file.storage_name)
        )
        .unwrap(),
        b"native artifact\n"
    );
    owner.close().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

// Each failure runs in a child process, so harness environment cannot race
// other tests. Exercise the real file owner and retain its successful case.
fn interrupted_children() {
    let mut failures = Vec::new();
    for point in [
        "message_upload",
        "message_snapshot",
        "pdf_sidecar",
        "message_materialize_publish",
    ] {
        let marker =
            std::env::temp_dir().join(format!("butler-file-fault-{}", uuid::Uuid::new_v4()));
        let isolation =
            std::env::temp_dir().join(format!("butler-file-child-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(isolation.join("home")).unwrap();
        std::fs::create_dir_all(isolation.join("data")).unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "gateway::message_file_store::tests::source_artifact_is_stored_once_with_original_metadata", "--nocapture"])
            .env("HOME", isolation.join("home"))
            .env("BUTLER_DATA", isolation.join("data"))
            .env("BUTLER_E2E_TIER", "stub")
            .env("BUTLER_FILE_TEST_CHILD", point)
            .env("BUTLER_E2E_FILE_FAULT", point)
            .env("BUTLER_E2E_FILE_FAULT_MARKER", &marker)
            .status().unwrap();
        let _ = std::fs::remove_file(marker);
        let _ = std::fs::remove_dir_all(isolation);
        if !status.success() {
            failures.push(point);
        }
    }
    assert!(
        failures.is_empty(),
        "interruption cases failed: {failures:?}"
    );
}

async fn interrupted_write(point: &str) {
    let root = std::env::temp_dir().join(format!("butler-file-interrupt-{}", uuid::Uuid::new_v4()));
    let directory = root.join("app-server/message-files");
    std::fs::create_dir_all(&directory).unwrap();
    let id = "file-11111111-1111-4111-8111-111111111111";
    let target = directory.join(if point == "pdf_sidecar" {
        format!("{id}.txt")
    } else {
        id.into()
    });
    let original = root.join("original");
    std::fs::write(&original, b"ORIGINAL_COMPLETE").unwrap();
    std::fs::hard_link(&original, &target).unwrap();
    let owner = AppMessageFiles::new(&root, Arc::new(Clock));
    let failed = match point {
        "message_upload" => owner
            .write_upload(AppFileWrite {
                name: "note.txt".into(),
                mime_type: Some("text/plain".into()),
                bytes: Bytes::from_static(b"NEW_COMPLETE"),
            })
            .await
            .is_err(),
        "message_snapshot" => owner
            .snapshot_source("source.md".into(), "NEW_COMPLETE".into())
            .await
            .is_err(),
        "pdf_sidecar" => {
            std::fs::write(directory.join(id), b"invalid pdf").unwrap();
            owner
                .prepare_uploaded(AppMessageFileSnapshot {
                    id: id.into(),
                    owner_session_id: None,
                    message_id: None,
                    kind: "generic".into(),
                    mime_type: "application/pdf".into(),
                    safe_name: "test.pdf".into(),
                    size_bytes: 11,
                    sha256: String::new(),
                    storage_name: id.into(),
                    created_at: String::new(),
                })
                .await
                .is_err()
        }
        _ => {
            let source = root.join("report.txt");
            std::fs::write(&source, b"NEW_COMPLETE").unwrap();
            owner
                .materialize(ArtifactMaterializationRequest {
                    allowed_roots: vec![root.clone()],
                    candidates: vec![ArtifactFileCandidate {
                        candidate_paths: vec![source],
                        name: "report.txt".into(),
                        mime_type: Some("text/plain".into()),
                    }],
                    existing_content_keys: vec![],
                })
                .await
                .is_err()
        }
    };
    assert!(failed, "fault not reached: {point}");
    assert_eq!(
        std::fs::read(&target).unwrap(),
        b"ORIGINAL_COMPLETE",
        "published failed write: {point}"
    );
    assert_eq!(
        std::fs::read(&original).unwrap(),
        b"ORIGINAL_COMPLETE",
        "truncated linked original: {point}"
    );
    owner.close().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
