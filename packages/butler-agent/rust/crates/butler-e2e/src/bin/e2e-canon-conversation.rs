//! Exercise the real conversation uniqueness guard while the scenario is stopped.
use butler_turn::btcc::{BtccStorage, TestStorageFixture};
use butler_work::store;
use serde_json::json;
type Failure = Box<dyn std::error::Error + Send + Sync>;
#[tokio::main]
async fn main() -> Result<(), Failure> {
    let args: Vec<_> = std::env::args().collect();
    let path = std::path::PathBuf::from(args.get(1).ok_or("database path")?);
    let first = args.get(2).ok_or("first work")?.clone();
    let second = args.get(3).ok_or("second work")?.clone();
    let fixture = TestStorageFixture::activated();
    let mut config = fixture.config("canon-conversation");
    config.activation.manifest_id = rusqlite::Connection::open(&path)?.query_row(
        "SELECT manifest_id FROM agent_storage_activation_marker WHERE singleton=1",
        [],
        |r| r.get(0),
    )?;
    config.path = path;
    let storage = BtccStorage::open(config).await?;
    let error = storage
        .work_model_write(move |tx| {
            let work = store::read_work(tx, &first)?;
            store::api::canon_conversation::link(
                tx,
                &store::Context {
                    now: 200,
                    actor: json!({"person":"tester"}),
                },
                &second,
                work["home_session_id"]
                    .as_str()
                    .ok_or(store::Error::Invalid("home"))?,
            )
        })
        .await
        .err()
        .ok_or("expected occupied conversation")?;
    assert_eq!(error.code(), "conversation_occupied");
    storage.close().await?;
    Ok(())
}
