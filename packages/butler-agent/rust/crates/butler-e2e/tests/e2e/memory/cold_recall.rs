//! A persisted vector generation is usable on the first recall after restart.
use super::super::memory_fixture::idle_activity;
use super::{batch, memory_stubs};
use butler_e2e::e2e::HarnessError;
use butler_platform::process_control::usage;
use std::time::{Duration, Instant};

// Share the production deadline arithmetic without linking the memory engine.
#[path = "../../../../butler-memory/src/cognition/memory_recall/budget.rs"]
mod recall_budget;

// Option A headroom chosen by the owner, not a measurement: observed fallback
// assembly is about 10 ms. Keep the derived (3,000 + 200) ms line and 5 s total.
const FALLBACK_ASSEMBLY_ALLOWANCE: Duration = Duration::from_millis(200);

const ASK: &str = "What is my bike lock code? Call recall_memory with cue bike lock code.";

#[tokio::test]
async fn first_recall_after_start_uses_vector_lane() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (setup, remember, code) = batch::setup_with_provider_delay("MEM-COLD-RECALL", 2_500)?;
    let mut s = setup.env("BUTLER_MEMORY_SYNC_TRACE", "1").start().await?;
    assert_eq!(s.turn("general", &remember).await?.1["state"], "delivered");
    memory_stubs::text_complete(&s.sandbox.data, 1).await?;
    batch::recall(&s, "general", ASK).await?;
    memory_stubs::vectors_complete(&s.sandbox.data, 2).await?;
    // Persist three conversation sources alongside the saved instruction.
    batch::recall(&s, "general", ASK).await?;
    memory_stubs::vectors_complete(&s.sandbox.data, 3).await?;
    let (_, persisted) = memory_stubs::unit_states(&s.sandbox.data)?;
    assert!(persisted > 0);
    s.agent.terminate().await?;
    let started = Instant::now();
    s.gw = s.agent.start_again().await?;
    let startup_ms = started.elapsed().as_millis();
    // Preserve an explicit provider first-token delay instead of replay's 20 ms cap.
    s.provider()?.set_pacing(butler_e2e::e2e::provider::Pacing {
        scale: 1.0,
        cap_ms: 2_500,
        min_ms: 0,
    });
    if let Some(workers) = usage::embedding_children(s.agent.pid().unwrap())? {
        assert!(workers.is_empty(), "startup spawned an embedding worker");
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
    butler_e2e::assert_wall_clock_budget!(
        Duration::from_millis(first_tool_ms.try_into().unwrap()),
        Duration::from_millis(750),
        "turn prefetch hides readiness behind provider latency",
    );
    assert_eq!(
        first["output"]["coverage"]["vectors"]["state"], "ok",
        "{first}"
    );
    assert_saved_instruction(&first, &code, 3);
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
        .filter(|line| line.contains("load_ms=") || line.contains("readiness_wait_ms="))
    {
        eprintln!("COLD-RECALL {line}");
    }
    // The first recall also creates a conversation turn. Settle that new work
    // before measuring an otherwise idle warm follow-up.
    memory_stubs::vectors_complete(&s.sandbox.data, 4).await?;
    assert_loaded_idle(&s).await?;
    s.provider()?.set_pacing(Default::default());
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
    assert_saved_instruction(&warm, &code, 4);
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

fn assert_saved_instruction(result: &serde_json::Value, code: &str, conversations: usize) {
    let results = result["output"]["results"].as_array().unwrap();
    assert_eq!(results.len(), conversations + 1, "{result}");
    let mut identities = std::collections::HashSet::new();
    let mut explicit = Vec::new();
    for row in results {
        assert!(identities.insert(row["episode_ref"].as_str().unwrap()));
        let evidence = row["evidence"].as_array().unwrap();
        assert!(!evidence.is_empty(), "{row}");
        for source in evidence {
            assert_eq!(source["source_resolved"], true, "{source}");
            assert_eq!(source["read_args"]["source_ref"], source["source_ref"]);
        }
        if evidence
            .iter()
            .any(|source| source["source_kind"] == "explicit_record")
        {
            explicit.push(row);
        } else {
            assert!(
                evidence
                    .iter()
                    .all(|source| source["source_kind"] == "conversation")
            );
        }
    }
    assert_eq!(explicit.len(), 1, "{result}");
    let saved = explicit[0];
    let text = format!("The user's bike lock code is {code}.");
    assert_eq!(saved["summary"], text);
    let evidence = saved["evidence"].as_array().unwrap();
    assert_eq!(evidence.len(), 1);
    assert_eq!(evidence[0]["source_kind"], "explicit_record");
    assert_eq!(evidence[0]["excerpt"], text);
    assert_eq!(evidence[0]["support"]["node_ref"], saved["episode_ref"]);
}

async fn assert_loaded_idle(s: &butler_e2e::e2e::scenario::Scenario) -> Result<(), HarnessError> {
    let Some(workers) = usage::embedding_children(s.agent.pid().unwrap())? else {
        return Ok(());
    };
    assert_eq!(workers.len(), 1);
    let pid = workers[0];
    super::super::memory_fixture::settle(&s.sandbox.data).await?;
    // The committed work is done; wait until the consumer has also parked.
    super::super::memory_fixture::wait_parked(s).await;
    let graph = super::coverage_support::graph(&s.sandbox.data);
    let version = || {
        graph
            .pragma_query_value::<u64, _>(None, "data_version", |row| row.get(0))
            .unwrap()
    };
    let commits = version();
    let started = Instant::now();
    let samples = idle_activity::sample_window(pid, Duration::from_secs(10), 10)
        .await?
        .unwrap();
    let (before, after) = (samples[0], samples[10]);
    // CPU and disk work may settle once (one event), but must not recur.
    if before.cpu_user_time.is_some() && before.cpu_system_time.is_some() {
        idle_activity::assert_no_recurring_activity(
            "loaded idle worker CPU time",
            &idle_activity::deltas(&samples, |sample| {
                sample.cpu_user_time.unwrap() + sample.cpu_system_time.unwrap()
            }),
        );
    }
    assert_eq!(version(), commits, "memory graph committed while idle");
    assert_eq!(before.read_chars, after.read_chars);
    idle_activity::assert_no_recurring_activity(
        "loaded idle worker physical reads",
        &idle_activity::deltas(&samples, |sample| sample.read_bytes),
    );
    assert_eq!(
        (before.write_chars, before.write_bytes),
        (after.write_chars, after.write_bytes)
    );
    eprintln!(
        "COLD-RECALL loaded_idle_ms={} graph_commits=0 write_delta=0",
        started.elapsed().as_millis()
    );
    Ok(())
}

#[tokio::test]
async fn slow_model_load_leaves_complete_text_fallback_within_capped_wait()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (setup, remember, code) = batch::setup("MEM-SLOW-RECALL")?;
    let mut s = setup.env("BUTLER_MEMORY_SYNC_TRACE", "1").start().await?;
    assert_eq!(s.turn("general", &remember).await?.1["state"], "delivered");
    memory_stubs::text_complete(&s.sandbox.data, 1).await?;
    batch::recall(&s, "general", ASK).await?;
    memory_stubs::vectors_complete(&s.sandbox.data, 2).await?;
    // Persist three conversation sources alongside the saved instruction.
    batch::recall(&s, "general", ASK).await?;
    memory_stubs::vectors_complete(&s.sandbox.data, 3).await?;
    s.agent.terminate().await?;
    // Existing owner-death fixture holds native initialization indefinitely.
    let barrier = s.sandbox.root.join("held-model-load");
    s.agent.launch.set_env(
        "BUTLER_E2E_EMBED_INIT_BARRIER",
        barrier.to_string_lossy().into_owned(),
    );
    s.gw = s.agent.start_again().await?;
    let started = Instant::now();
    let result = match batch::recall(&s, "general", ASK).await {
        Ok(result) => result,
        Err(error) => {
            eprintln!("SLOW-RECALL failed turn diagnostics: {}", s.agent.logs());
            return Err(error);
        }
    };
    let turn_ms = started.elapsed().as_millis();
    let tool_ms = recall_tool_ms(&s.sandbox.data);
    assert!(
        barrier.exists(),
        "worker must be held inside initialization"
    );
    assert_eq!(
        result["output"]["coverage"]["vectors"]["state"], "unavailable",
        "{result}"
    );
    assert_saved_instruction(&result, &code, 3);
    assert!(result["output"]["next_cursor"].is_null(), "{result}");
    assert!(
        result["output"]["results"].to_string().contains(&code),
        "{result}"
    );
    eprintln!("SLOW-RECALL tool_ms={tool_ms} answer_ms={turn_ms} complete_results=4");
    butler_e2e::assert_wall_clock_budget!(
        Duration::from_millis(tool_ms.try_into().unwrap()),
        Duration::from_millis(
            (recall_budget::TOTAL_MS - recall_budget::TEXT_RESERVE_MS)
                .try_into()
                .unwrap(),
        ) + FALLBACK_ASSEMBLY_ALLOWANCE,
        "vector deadline plus text fallback assembly",
    );
    butler_e2e::assert_wall_clock_budget!(
        Duration::from_millis(turn_ms.try_into().unwrap()),
        Duration::from_secs(4),
        "slow-load fallback answer",
    );
    if let Some(workers) = usage::embedding_children(s.agent.pid().unwrap())? {
        assert_eq!(workers.len(), 1, "load continues after recall times out");
    }
    eprintln!("SLOW-RECALL load_continues=true");
    s.finish().await
}

#[path = "cold_overrun.rs"]
mod overrun;

#[path = "lane_overrun.rs"]
mod lane_overrun;

#[path = "drain_bounds.rs"]
mod drain_bounds;

#[path = "restart_recall.rs"]
mod restart;

#[path = "compaction.rs"]
mod compaction;
