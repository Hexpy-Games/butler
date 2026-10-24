//! The first recall of a fresh generation, before the model answers, serves
//! its text lanes without waiting on a query embedding it cannot search with.
use super::{ASK, assert_saved_instruction, batch, memory_stubs};
use butler_e2e::e2e::HarnessError;
use serde_json::json;

/// Milliseconds since midnight of a trace line's UTC timestamp.
fn at(line: &str) -> f64 {
    let time = &line[11..23];
    let parts = time
        .split(':')
        .map(|part| part.parse::<f64>().unwrap())
        .collect::<Vec<_>>();
    (parts[0] * 3600.0 + parts[1] * 60.0 + parts[2]) * 1000.0
}

fn value(line: &str, key: &str) -> f64 {
    line.split_once(key)
        .unwrap()
        .1
        .split_whitespace()
        .next()
        .unwrap()
        .parse()
        .unwrap()
}

#[tokio::test]
async fn first_generation_recall_does_not_wait_for_the_model() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (setup, remember, code) = batch::setup("MEM-FIRST-GENERATION")?;
    let release = setup.sandbox.root.join("embed-release");
    let s = setup
        .env("BUTLER_MEMORY_SYNC_TRACE", "1")
        .env("BUTLER_E2E_HOLD_POINT", "memory_embedding")
        .env("BUTLER_E2E_HOLD_RELEASE", release.to_string_lossy())
        .start()
        .await?;
    assert_eq!(s.turn("general", &remember).await?.1["state"], "delivered");
    memory_stubs::text_complete(&s.sandbox.data, 1).await?;
    assert_eq!(
        memory_stubs::unit_states(&s.sandbox.data)?.1,
        0,
        "vectors exist"
    );
    let before = s.agent.logs().len();
    // The worker answers no embedding until the recall has returned.
    let first = batch::recall(&s, "general", ASK).await?;
    std::fs::write(&release, b"")?;
    let logs = s.agent.logs();
    let trace = logs[before..].lines().collect::<Vec<_>>();
    let line = |marker: &str| trace.iter().find(|line| line.contains(marker)).copied();
    let started = at(line("[embedding-worker] queued class=Interactive").unwrap());
    let alias = line("[memory-recall] alias_ms=").unwrap();
    let text_start = at(alias) - value(alias, "alias_ms=");
    let graph = at(line("stage=recall_v2_graph_read_ppr").unwrap());
    eprintln!(
        "FIRST-GENERATION text_wait_ms={:.0} candidate_and_graph_ms={:.0} vectors={}",
        text_start - started,
        graph - text_start,
        first["output"]["coverage"]["vectors"]
    );
    assert_eq!(
        first["output"]["coverage"]["graph"]["state"], "ok",
        "{first}"
    );
    assert_saved_instruction(&first, &code, 1);
    // No vector exists yet: the lane reports that, not a model deadline.
    assert_eq!(
        first["output"]["coverage"]["vectors"]["codes"],
        json!(["embedding_not_configured"]),
        "{first}"
    );
    // The recall still started the on-demand load that embeds both turns.
    memory_stubs::vectors_complete(&s.sandbox.data, 2).await?;
    s.finish().await
}
