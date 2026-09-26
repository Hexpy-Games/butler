#![cfg(unix)]

use std::collections::HashMap;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use super::integration::Fixture;
use crate::workspace::NativeSessionWorkspaceRecovery;

#[tokio::test]
async fn admitted_git_child_is_drained_by_same_command_owner() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = Fixture::new().await;
    let fake_bin = fixture.root.join("fake-bin");
    std::fs::create_dir(&fake_bin).unwrap();
    let started = fixture.root.join("git-started");
    let fake_git = fake_bin.join("git");
    std::fs::write(
        &fake_git,
        format!(
            "#!/bin/sh\nprintf started > '{}'\nexec /bin/sleep 10\n",
            started.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&fake_git, std::fs::Permissions::from_mode(0o755)).unwrap();
    let recovery = NativeSessionWorkspaceRecovery::new(
        fixture.store.clone(),
        fixture.commands.clone(),
        fixture.files.clone(),
        Arc::new(HashMap::from([(
            "PATH".into(),
            fake_bin.to_string_lossy().into_owned(),
        )])),
    );
    let cancellation = CancellationToken::new();
    let cancelling = cancellation.clone();
    let cancelled_recovery = recovery.clone();
    let cancelled_task = tokio::spawn(async move {
        cancelled_recovery
            .recover("session", None, cancelling)
            .await
            .unwrap()
    });
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while !started.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    cancellation.cancel();
    let cancelled = cancelled_task.await.unwrap();
    assert_eq!(
        cancelled.workspace_reference.get().unwrap_err().code(),
        "cancelled"
    );
    assert_eq!(fixture.commands.active_count(), 0);
    std::fs::remove_file(&started).unwrap();
    let task = tokio::spawn(async move {
        recovery
            .recover("session", None, CancellationToken::new())
            .await
            .unwrap()
    });
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while !started.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), fixture.commands.close())
        .await
        .unwrap();
    let result = task.await.unwrap();
    assert_eq!(
        result.workspace_reference.get().unwrap_err().code(),
        "cancelled"
    );
    assert_eq!(fixture.commands.active_count(), 0);
    fixture.close().await;
}
