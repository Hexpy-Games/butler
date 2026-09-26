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

#[tokio::test]
async fn source_artifact_is_stored_once_with_original_metadata() {
    let root = std::env::temp_dir().join(format!("butler-app-files-{}", uuid::Uuid::new_v4()));
    let source = root.join("artifacts/public-data/report.MD");
    std::fs::create_dir_all(source.parent().unwrap()).unwrap();
    std::fs::write(&source, b"native artifact\n").unwrap();
    let owner = NativeAppMessageFiles::new(root.clone(), Arc::new(Clock));
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
