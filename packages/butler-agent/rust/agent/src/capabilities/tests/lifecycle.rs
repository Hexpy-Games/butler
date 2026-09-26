use std::sync::Arc;

use super::Fixture;

#[tokio::test]
async fn dropped_caller_is_owned_until_real_read_completes_and_close_drains() {
    let fixture = Fixture::new();
    fixture.write("owned.txt", b"real file read after release");
    let barrier = Arc::new(crate::workspace::TestReadBarrier {
        entered: std::sync::Barrier::new(2),
        release: std::sync::Barrier::new(2),
    });
    fixture.files.set_test_barrier(Arc::clone(&barrier));
    let workspace = Arc::clone(&fixture.files);
    let root = fixture.root.clone();
    let task = tokio::spawn(async move {
        workspace
            .read_one(crate::workspace::ReadFileInput {
                root,
                path: "owned.txt".into(),
                relative_only: false,
                protected_roots: vec![],
                start_line: None,
                limit_lines: None,
                max_bytes: 65_536,
                offset_bytes: None,
            })
            .await
    });
    let entered = Arc::clone(&barrier);
    tokio::task::spawn_blocking(move || entered.entered.wait())
        .await
        .unwrap();
    assert_eq!(fixture.files.active_count(), 1);
    task.abort();
    let workspace = Arc::clone(&fixture.files);
    let close = tokio::spawn(async move { workspace.close().await });
    tokio::task::yield_now().await;
    assert!(!close.is_finished());
    let release = Arc::clone(&barrier);
    tokio::task::spawn_blocking(move || release.release.wait())
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), close)
        .await
        .expect("workspace shutdown must drain accepted read")
        .unwrap();
    assert_eq!(fixture.files.active_count(), 0);
    let result = fixture
        .files
        .read_one(crate::workspace::ReadFileInput {
            root: fixture.root.clone(),
            path: "owned.txt".into(),
            relative_only: false,
            protected_roots: vec![],
            start_line: None,
            limit_lines: None,
            max_bytes: 65_536,
            offset_bytes: None,
        })
        .await;
    assert_eq!(result.unwrap_err().code, "workspace_files_closed");
}
