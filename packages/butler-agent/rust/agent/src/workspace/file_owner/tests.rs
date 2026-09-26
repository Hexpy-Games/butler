use std::sync::{Arc, Barrier};

use super::NativeWorkspaceFiles;

/// An admitted blocking operation stays owned after its caller is dropped,
/// and close waits for it before rejecting new work.
#[tokio::test]
async fn dropped_caller_is_owned_until_operation_completes_and_close_drains() {
    let files = NativeWorkspaceFiles::new(1);
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let task = tokio::spawn({
        let files = files.clone();
        let (entered, release) = (Arc::clone(&entered), Arc::clone(&release));
        async move {
            files
                .run(move || {
                    entered.wait();
                    release.wait();
                })
                .await
        }
    });
    tokio::task::spawn_blocking(move || entered.wait())
        .await
        .unwrap();
    assert_eq!(files.active_count(), 1);
    task.abort();
    let mut close = tokio::spawn({
        let files = files.clone();
        async move { files.close().await }
    });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), &mut close)
            .await
            .is_err(),
        "close finished while an admitted operation was running"
    );
    tokio::task::spawn_blocking(move || release.wait())
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), close)
        .await
        .expect("workspace shutdown must drain the admitted operation")
        .unwrap();
    assert_eq!(files.active_count(), 0);
    assert_eq!(
        files.run(|| ()).await.unwrap_err().code,
        "workspace_files_closed"
    );
}
