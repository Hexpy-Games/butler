use super::super::memory_stubs;
use super::super::memory_wiring_more::support;
use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::Setup};
use std::{fs, io::ErrorKind, time::Duration};

#[tokio::test]
async fn mem_05_earlier_conversations_stay_out_of_a_first_generation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut cassette = Cassette::load("MEM-01")?;
    memory_stubs::ordinary(&mut cassette);
    let mut s = Setup::new("MEM-05-EARLIER")?
        .stub_cassette(cassette)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .start()
        .await?;
    s.provider()?.set_memory_responder(support::meaning);
    let data = &s.sandbox.data;
    let memory = data.join("cognition/memory");
    let (_, earlier) = s
        .turn("general", memory_stubs::ORDINARY_MESSAGES[0])
        .await?;
    assert_eq!(earlier["state"], "delivered", "{earlier}");
    assert!(!memory.join("active-generation.json").exists());
    s.agent.terminate().await?;
    fs::remove_file(memory.join("fresh-initialization.json"))?;
    fs::write(data.join("state/e2e-memory-bootstrap-release"), b"")?;
    s.gw = s.agent.start_again().await?;
    s.provider()?.set_memory_responder(support::meaning);
    let (_, new) = s
        .turn("general", memory_stubs::ORDINARY_MESSAGES[1])
        .await?;
    assert_eq!(new["state"], "delivered", "{new}");

    let queue = memory.join("queue/sync.jsonl");
    let db = tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            if let Ok(graph) = memory_stubs::graph_path(data) {
                let db = butler_platform::sqlite::open_with_flags(
                    graph,
                    rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                )?;
                let ready: bool = db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM memory_state WHERE key='canonical_catchup_sweep_done' AND value='1')
                     AND EXISTS(SELECT 1 FROM memory_chunks WHERE source_key LIKE 'conversation_turn:%')
                     AND NOT EXISTS(SELECT 1 FROM memory_projection_jobs j
                         JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision
                         WHERE json_extract(j.semantic_graph_state,'$.state')!='complete'
                            OR json_extract(j.hot_cache_state,'$.state')!='complete')",
                    [],
                    |row| row.get(0),
                )?;
                let queue_empty = match fs::metadata(&queue) {
                    Ok(metadata) => metadata.len() == 0,
                    Err(error) if error.kind() == ErrorKind::NotFound => true,
                    Err(error) => return Err(error.into()),
                };
                if ready && queue_empty {
                    return Ok::<_, HarnessError>(db);
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("catch-up, projection and the sync queue must finish")?;
    let turns: u64 = db.query_row(
        "SELECT COUNT(*) FROM memory_reset_admissions WHERE kind='turn'",
        [],
        |row| row.get(0),
    )?;
    let messages: u64 = db.query_row(
        "SELECT COUNT(*) FROM memory_reset_admissions WHERE kind='message'",
        [],
        |row| row.get(0),
    )?;
    let chunks: u64 = db.query_row(
        "SELECT COUNT(*) FROM memory_chunks WHERE source_key LIKE 'conversation_turn:%'",
        [],
        |row| row.get(0),
    )?;
    let excluded_chunks: u64 = db.query_row(
        "SELECT COUNT(*) FROM memory_chunks WHERE source_key LIKE 'conversation_turn:%'
         AND substr(source_key,19) IN (SELECT id FROM memory_reset_admissions WHERE kind='turn')",
        [],
        |row| row.get(0),
    )?;
    assert!(turns >= 1);
    assert!(messages >= 2);
    assert_eq!(chunks, 1);
    assert_eq!(excluded_chunks, 0);
    drop(db);
    assert!(s.provider()?.memory_requests().iter().any(|request| {
        request
            .to_string()
            .contains(memory_stubs::ORDINARY_MESSAGES[1])
    }));
    s.finish().await
}
