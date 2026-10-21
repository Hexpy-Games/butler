//! Dev-only process boundary: exercise the real writer/read lanes while the
//! agent is stopped. The WMS scenario owns the isolated data directory.
#![allow(clippy::expect_used, reason = "fixture assertions")]
use butler_turn::btcc::{BtccStorage, TestStorageFixture};
use butler_work::{store::*, work_types::*};
use serde_json::json;
type Failure = Box<dyn std::error::Error + Send + Sync>;
#[tokio::main]
async fn main() -> std::result::Result<(), Failure> {
    let path =
        std::path::PathBuf::from(std::env::args_os().nth(1).ok_or("database path required")?);
    let id = std::env::args().nth(2).ok_or("work id required")?;
    let fixture = TestStorageFixture::activated();
    let mut config = fixture.config("work-store");
    config.activation.manifest_id = rusqlite::Connection::open(&path)?.query_row(
        "SELECT manifest_id FROM agent_storage_activation_marker WHERE singleton=1",
        [],
        |r| r.get(0),
    )?;
    config.path = path;
    let storage = BtccStorage::open(config).await?;
    let result = exercise(&storage, id).await;
    storage.close().await?;
    result
}
async fn exercise(storage: &BtccStorage, id: String) -> std::result::Result<(), Failure> {
    let mut changes = storage.subscribe_changes();
    let work_id = id.clone();
    let written = storage
        .work_model_write(move |tx| {
            let ctx = Context {
                now: 200,
                actor: json!({"person":"companion"}),
            };
            let row = read_work(tx, &work_id)?;
            let revision = row["revision"].as_i64().ok_or(Error::Invalid("revision"))?;
            transition(
                tx,
                &ctx,
                &work_id,
                revision,
                RunState::Failed,
                false,
                Some("task_failed"),
            )
        })
        .await?;
    assert!(changes.has_changed()?);
    changes.borrow_and_update();
    let chain = written["chain_id"].as_str().ok_or("chain id")?.to_owned();
    let rows = storage
        .work_model_read(move |db| undecided_holds(db, &chain))
        .await?;
    assert_eq!(rows.len(), 1);
    assert!(!changes.has_changed()?);
    // Typed domain errors survive the port, and a failed write rolls back all
    // accompanying events/counters before a later read or restart can see it.
    let stale = storage
        .work_model_write(move |tx| {
            let ctx = Context {
                now: 201,
                actor: json!({"person":"companion"}),
            };
            transition(tx, &ctx, &id, 0, RunState::Done, true, None)
        })
        .await
        .expect_err("stale revision");
    assert_eq!(stale.code(), "conflict");
    if let butler_turn::btcc::StorageError::Port {
        source: Some(source),
        ..
    } = stale
    {
        assert!(matches!(
            source.downcast_ref::<butler_work::store::Error>(),
            Some(butler_work::store::Error::Conflict { .. })
        ));
    } else {
        return Err("typed conflict lost".into());
    }
    Ok(())
}
