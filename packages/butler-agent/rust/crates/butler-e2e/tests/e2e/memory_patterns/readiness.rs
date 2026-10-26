//! A prior park can precede discovery of newly committed standalone sources.
use super::*;
use butler_platform::sqlite;
use rusqlite::OpenFlags;

pub(super) async fn settle(s: &Scenario) -> Result<(), HarnessError> {
    let data = &s.sandbox.data;
    let source = sqlite::open_with_flags(
        data.join("runtime/conversation-store.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let head: u64 = source.query_row(
        "SELECT COALESCE(MAX(seq),0) FROM conversation_source_changes",
        [],
        |row| row.get(0),
    )?;
    drop(source);
    let memory = data.join("cognition/memory");
    let active: Value =
        serde_json::from_slice(&std::fs::read(memory.join("active-generation.json"))?)?;
    let graph = memory
        .join("generations")
        .join(active["generation_id"].as_str().unwrap())
        .join("graph.sqlite");
    // The consumer commits this watermark only after registering every source
    // in the change page. Turn-only settlement cannot cover imported messages.
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let db = sqlite::open_with_flags(&graph, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            let caught_up: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM memory_state
                 WHERE key='canonical_catchup_change_seq' AND CAST(value AS INTEGER)>=?1)",
                [head],
                |row| row.get(0),
            )?;
            drop(db);
            if caught_up && super::super::memory_idle::catchup_checkpoint_current(data, &graph) {
                return Ok::<_, HarnessError>(());
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("canonical source changes reconciled before consolidation")?;
    super::super::memory_fixture::settle(data).await
}
