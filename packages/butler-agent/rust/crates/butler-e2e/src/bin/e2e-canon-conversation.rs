//! Exercise many-to-many conversation binding on the real writer lane.
use butler_canon::store;
use butler_turn::btcc::{BtccStorage, TestStorageFixture};
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
    storage
        .canon_write(move |tx| {
            let work = store::api::epic(tx, &first)?;
            store::api::canon_conversation::link(
                tx,
                &store::Context {
                    now: chrono::Utc::now().timestamp_millis(),
                    actor: json!({"person":"tester"}),
                },
                &second,
                Some(
                    work["sessions"][0]["session_id"]
                        .as_str()
                        .ok_or(store::Error::Invalid("session"))?,
                ),
                "unused-new-session",
            )
        })
        .await?;
    storage.close().await?;
    Ok(())
}
