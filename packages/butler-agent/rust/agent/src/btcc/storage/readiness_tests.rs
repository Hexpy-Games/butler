use std::time::Duration;

use rusqlite::Connection;
use tokio_util::sync::CancellationToken;

use super::repository::BtccRepositories;
use super::tests::Fixture;
use super::*;
use crate::btcc::StorageReadiness;

#[tokio::test(flavor = "current_thread")]
async fn write_probe_waits_for_external_lock_and_restores_owner_state() {
    let fixture = Fixture::activated();
    let storage = BtccStorage::open(fixture.config("repository-readiness"))
        .await
        .expect("open storage");
    let repositories = BtccRepositories::new(storage, None);
    let external = Connection::open(&fixture.path).expect("external test connection");
    external
        .execute_batch("BEGIN IMMEDIATE")
        .expect("hold external write lock");

    let cancelled = CancellationToken::new();
    let wait = tokio::spawn({
        let repositories = repositories.clone();
        let cancellation = cancelled.clone();
        async move { repositories.wait(cancellation).await }
    });
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert!(
        !wait.is_finished(),
        "write probe must observe the external lock"
    );
    cancelled.cancel();
    // Liveness bound, not a latency assertion: one probe waits at most its
    // 250 ms busy timeout, but loaded CI runners have stalled past 1 s here.
    let error = tokio::time::timeout(Duration::from_secs(30), wait)
        .await
        .expect("cancelled probe settles after admitted SQL")
        .expect("wait task")
        .expect_err("cancelled readiness");
    assert_eq!(error.code(), "cancelled");
    let state = repositories
        .storage
        .execute(|db| {
            let timeout: u64 = db
                .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
                .map_err(StorageError::sqlite)?;
            Ok((timeout, db.is_autocommit()))
        })
        .await
        .expect("owner state restored");
    assert_eq!(state, (5_000, true));

    external.execute_batch("ROLLBACK").expect("release lock");
    repositories
        .wait(CancellationToken::new())
        .await
        .expect("probe becomes writable");
    repositories.close().await.expect("close repository");
}
