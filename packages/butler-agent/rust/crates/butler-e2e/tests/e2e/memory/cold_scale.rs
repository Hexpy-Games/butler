//! Immediate post-restart recall with the shared owner-history fixtures.
use super::{ASK, batch, memory_stubs, recall_tool_ms};
use butler_e2e::e2e::HarnessError;
use butler_platform::process_control::usage;
use serde_json::Value;
use std::{
    path::Path,
    time::{Duration, Instant},
};

#[tokio::test]
async fn first_recall_after_restart_owner_scale_is_complete() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (setup, remember, code) = batch::setup("MEM-COLD-SCALE")?;
    let mut s = setup.env("BUTLER_MEMORY_SYNC_TRACE", "1").start().await?;
    assert_eq!(s.turn("general", &remember).await?.1["state"], "delivered");
    memory_stubs::text_complete(&s.sandbox.data, 1).await?;
    batch::recall(&s, "general", ASK).await?;
    memory_stubs::vectors_complete(&s.sandbox.data, 2).await?;
    batch::recall(&s, "general", ASK).await?;
    memory_stubs::vectors_complete(&s.sandbox.data, 3).await?;
    s.agent.terminate().await?;
    seed_history(&s.sandbox.data)?;
    let transcripts = crate::transcript_scale::seed(&s.sandbox.data)?;
    let started = Instant::now();
    s.gw = s.agent.start_again().await?;
    let startup_ms = started.elapsed().as_millis();
    if let Some(workers) = usage::embedding_children(s.agent.pid().unwrap())? {
        assert!(workers.is_empty(), "startup spawned an embedding worker");
    }
    let started = Instant::now();
    let first = batch::recall(&s, "general", ASK).await?;
    let turn_ms = started.elapsed().as_millis();
    let tool_ms = recall_tool_ms(&s.sandbox.data);
    // Emit evidence before assertions so a baseline failure retains its timings.
    eprintln!(
        "COLD-SCALE startup_ms={startup_ms} turn_ms={turn_ms} tool_ms={tool_ms} coverage={} results={}",
        first["output"]["coverage"],
        first["output"]["results"].as_array().unwrap().len()
    );
    for line in s.agent.logs().lines().filter(|line| {
        line.contains("[embedding-worker]")
            || line.contains("[memory-vector]")
            || line.contains("[memory-recall]")
    }) {
        eprintln!("COLD-SCALE {line}");
    }
    if let Some(workers) = usage::embedding_children(s.agent.pid().unwrap())? {
        assert_eq!(workers.len(), 1);
        if let Some(sample) = usage::sample(workers[0])? {
            eprintln!("COLD-SCALE loaded_rss_bytes={}", sample.resident_bytes);
        }
    }
    assert_complete(&first, &code, 3);
    assert!(
        tool_ms < 5_000,
        "first recall exceeded the existing 5 s budget"
    );
    memory_stubs::vectors_complete(&s.sandbox.data, 4).await?;
    let warm = batch::recall(&s, "general", ASK).await?;
    assert_complete(&warm, &code, 4);
    eprintln!(
        "COLD-SCALE warm_tool_ms={}",
        recall_tool_ms(&s.sandbox.data)
    );
    let identities = |result: &Value| -> Vec<Value> {
        result["output"]["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["episode_ref"].clone())
            .collect()
    };
    let first_ids = identities(&first);
    let warm_ids = identities(&warm)
        .into_iter()
        .filter(|id| first_ids.contains(id))
        .collect::<Vec<_>>();
    assert_eq!(
        first_ids, warm_ids,
        "restart changed the order of persisted results"
    );
    memory_stubs::vectors_complete(&s.sandbox.data, 5).await?;
    super::assert_loaded_idle(&s).await?;
    // Reaping a child transfers its lifetime I/O counters to the parent on
    // Linux. Measure the parked process after that transfer, and separately
    // retain the loaded worker's zero-CPU/zero-I/O assertion above.
    park(&s).await?;
    idle(&s).await?;
    crate::data_perf::assert_app(&s.sandbox.data)?;
    crate::btcc_scale::assert_complete(&s.sandbox.data)?;
    crate::transcript_scale::assert_complete(&s.sandbox.data, &transcripts)?;
    s.finish().await
}

fn seed_history(data: &Path) -> Result<(), HarnessError> {
    crate::app_storage_scale::seed::seed_owner_scale(
        &rusqlite::Connection::open(data.join("app-server/butler-client.sqlite"))?,
        crate::owner_scale::APP_BLOB_BYTES,
    );
    crate::data_perf::seed_extra_app(data)?;
    crate::btcc_scale::seed(data)
}

pub(super) fn assert_complete(result: &Value, code: &str, conversations: usize) {
    let output = &result["output"];
    assert_eq!(output["coverage"]["vectors"]["state"], "ok", "{result}");
    assert_eq!(output["status"], "complete", "{result}");
    let results = output["results"].as_array().unwrap();
    super::assert_saved_instruction(result, code, conversations);
    assert!(output["next_cursor"].is_null(), "{result}");
    assert!(
        results.iter().any(|item| item.to_string().contains(code)
            && item["channels"]
                .as_array()
                .unwrap()
                .iter()
                .any(|lane| lane == "vector")),
        "{result}"
    );
}

async fn park(s: &butler_e2e::e2e::scenario::Scenario) -> Result<(), HarnessError> {
    let pid = s.agent.pid().unwrap();
    let Some(workers) = usage::embedding_children(pid)? else {
        return Ok(());
    };
    assert_eq!(workers.len(), 1);
    let parent = usage::sample(pid)?.unwrap();
    let child = usage::sample(workers[0])?.unwrap();
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            if usage::embedding_children(pid)?.unwrap().is_empty() {
                let after = usage::sample(pid)?.unwrap();
                if !usage::INCLUDES_REAPED_CHILD_IO
                    || (after.read_chars.unwrap()
                        >= parent.read_chars.unwrap() + child.read_chars.unwrap()
                        && after.write_chars.unwrap()
                            >= parent.write_chars.unwrap() + child.write_chars.unwrap())
                {
                    eprintln!("COLD-SCALE worker_exited=true lifetime_io_settled=true");
                    return Ok::<_, HarnessError>(());
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("idle embedding worker must exit and be reaped")
}

async fn idle(s: &butler_e2e::e2e::scenario::Scenario) -> Result<(), HarnessError> {
    let pid = s.agent.pid().unwrap();
    let Some(before) = usage::sample(pid)? else {
        return Ok(());
    };
    tokio::time::sleep(Duration::from_secs(60)).await;
    let after = usage::sample(pid)?.unwrap();
    assert!(usage::embedding_children(pid)?.is_none_or(|workers| workers.is_empty()));
    let reads = after.read_chars.zip(before.read_chars).map(|(a, b)| a - b);
    let writes = after
        .write_chars
        .zip(before.write_chars)
        .map(|(a, b)| a - b);
    eprintln!(
        "COLD-SCALE idle_60s read_chars={reads:?} write_chars={writes:?} read_bytes={} write_bytes={}",
        after.read_bytes - before.read_bytes,
        after.write_bytes - before.write_bytes
    );
    assert!(reads.is_none_or(|bytes| bytes <= 1_000_000));
    assert!(writes.is_none_or(|bytes| bytes <= 1_000_000));
    assert!(after.read_bytes - before.read_bytes <= 1_000_000);
    assert!(after.write_bytes - before.write_bytes <= 1_000_000);
    Ok(())
}

#[tokio::test]
async fn restart_keeps_worker_and_deferred_vectors_idle_until_demand() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (setup, remember, code) = batch::setup("MEM-RESTART-DEFERRED")?;
    let mut s = setup.env("BUTLER_MEMORY_SYNC_TRACE", "1").start().await?;
    assert_eq!(s.turn("general", &remember).await?.1["state"], "delivered");
    memory_stubs::text_complete(&s.sandbox.data, 1).await?;
    batch::recall(&s, "general", ASK).await?;
    memory_stubs::vectors_complete(&s.sandbox.data, 2).await?;
    batch::recall(&s, "general", ASK).await?;
    memory_stubs::vectors_complete(&s.sandbox.data, 3).await?;
    s.agent.terminate().await?;
    // A crash can leave a committed vector whose unit receipt needs recovery.
    // Startup must leave both the worker and that deferred work idle.
    let graph = memory_stubs::graph_path(&s.sandbox.data)?;
    let db = rusqlite::Connection::open(graph)?;
    assert_eq!(db.execute("UPDATE memory_vector_units SET state='pending' WHERE unit_id=(SELECT unit_id FROM memory_vector_units WHERE state='complete' ORDER BY unit_id LIMIT 1)", [])?, 1);
    drop(db);
    let before = memory_stubs::unit_states(&s.sandbox.data)?;
    assert_eq!(before.0, 1);
    s.gw = s.agent.start_again().await?;
    for _ in 0..2 {
        if let Some(workers) = usage::embedding_children(s.agent.pid().unwrap())? {
            assert!(workers.is_empty(), "startup spawned an embedding worker");
        }
        assert!(
            !s.agent
                .current_logs()
                .await?
                .contains("[embedding-worker] ready")
        );
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    assert_eq!(memory_stubs::unit_states(&s.sandbox.data)?, before);
    let first = batch::recall(&s, "general", ASK).await?;
    assert_complete(&first, &code, 3);
    memory_stubs::vectors_complete(&s.sandbox.data, 4).await?;
    eprintln!(
        "RESTART-DEFERRED startup_workers=0 idle_pending=1 demand_pending=0 complete_results=4"
    );
    s.finish().await
}
