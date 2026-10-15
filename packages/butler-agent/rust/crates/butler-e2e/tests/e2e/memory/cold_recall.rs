//! A persisted vector generation is usable on the first recall after restart.
use super::{batch, memory_stubs};
use butler_e2e::e2e::HarnessError;
use butler_platform::process_control::usage;
use std::time::Instant;

const ASK: &str = "What is my bike lock code? Call recall_memory with cue bike lock code.";

#[tokio::test]
async fn first_recall_after_start_uses_vector_lane() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (setup, remember, code) = batch::setup("MEM-COLD-RECALL")?;
    let mut s = setup.start().await?;
    assert_eq!(s.turn("general", &remember).await?.1["state"], "delivered");
    memory_stubs::text_complete(&s.sandbox.data, 1).await?;
    batch::recall(&s, "general", ASK).await?;
    memory_stubs::vectors_complete(&s.sandbox.data, 2).await?;
    let (_, persisted) = memory_stubs::unit_states(&s.sandbox.data)?;
    assert!(persisted > 0);
    s.agent.terminate().await?;
    let started = Instant::now();
    s.gw = s.agent.start_again().await?;
    let startup_ms = started.elapsed().as_millis();
    if let Some(workers) = usage::embedding_children(s.agent.pid().unwrap())? {
        assert!(workers.is_empty(), "startup must not load the model");
    }
    let started = Instant::now();
    let first = batch::recall(&s, "general", ASK).await?;
    let first_tool_ms = recall_tool_ms(&s.sandbox.data);
    eprintln!(
        "COLD-RECALL startup_ms={startup_ms} first_turn_ms={} first_tool_ms={first_tool_ms} persisted={persisted} coverage={}",
        started.elapsed().as_millis(),
        first["output"]["coverage"]["vectors"]
    );
    assert!(
        first_tool_ms < 5_000,
        "first recall exceeded 5 s: {first_tool_ms} ms"
    );
    assert_eq!(
        first["output"]["coverage"]["vectors"]["state"], "ok",
        "{first}"
    );
    // The explicit record and both completed conversation turns remain present.
    assert_eq!(
        first["output"]["results"].as_array().unwrap().len(),
        3,
        "{first}"
    );
    assert!(first["output"]["next_cursor"].is_null(), "{first}");
    assert!(
        first["output"]["results"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item.to_string().contains(&code)
                && item["channels"]
                    .as_array()
                    .is_some_and(|lanes| lanes.iter().any(|lane| lane == "vector"))),
        "{first}"
    );
    if let Some(workers) = usage::embedding_children(s.agent.pid().unwrap())? {
        assert_eq!(workers.len(), 1);
        if let Some(sample) = usage::sample(workers[0])? {
            eprintln!("COLD-RECALL loaded_rss_bytes={}", sample.resident_bytes);
        }
    }
    for line in s
        .agent
        .logs()
        .lines()
        .filter(|line| line.contains("load_ms="))
    {
        eprintln!("COLD-RECALL {line}");
    }
    // The first recall also creates a conversation turn. Settle that new work
    // before measuring an otherwise idle warm follow-up.
    memory_stubs::vectors_complete(&s.sandbox.data, 3).await?;
    let started = Instant::now();
    let warm = batch::recall(&s, "general", ASK).await?;
    eprintln!(
        "COLD-RECALL warm_turn_ms={} warm_tool_ms={}",
        started.elapsed().as_millis(),
        recall_tool_ms(&s.sandbox.data)
    );
    assert_eq!(
        warm["output"]["coverage"]["vectors"]["state"], "ok",
        "{warm}"
    );
    assert_eq!(
        warm["output"]["results"].as_array().unwrap().len(),
        4,
        "{warm}"
    );
    assert!(warm["output"]["next_cursor"].is_null(), "{warm}");
    assert!(
        warm["output"]["results"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item.to_string().contains(&code)
                && item["channels"]
                    .as_array()
                    .is_some_and(|lanes| lanes.iter().any(|lane| lane == "vector"))),
        "{warm}"
    );
    s.finish().await
}

fn recall_tool_ms(data: &std::path::Path) -> i64 {
    let db = butler_platform::sqlite::open_with_flags(
        data.join("agent-runtime/btcc.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let (start, end): (String, String) = db.query_row(
        "SELECT started_at,finished_at FROM btcc_guided_tool_calls WHERE tool_name='recall_memory' ORDER BY rowid DESC LIMIT 1",
        [], |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    (chrono::DateTime::parse_from_rfc3339(&end).unwrap()
        - chrono::DateTime::parse_from_rfc3339(&start).unwrap())
    .num_milliseconds()
}
