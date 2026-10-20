//! Deadline expiry must discard a sent embed without discarding its loaded worker.
use super::{ASK, assert_saved_instruction, batch, memory_stubs, recall_tool_ms, scale};
use butler_e2e::e2e::HarnessError;
use butler_platform::process_control::usage;

#[tokio::test]
async fn expired_embed_after_load_keeps_one_warm_worker() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (setup, remember, code) = batch::setup("MEM-COLD-OVERRUN")?;
    let mut s = setup.env("BUTLER_MEMORY_SYNC_TRACE", "1").start().await?;
    assert_eq!(s.turn("general", &remember).await?.1["state"], "delivered");
    memory_stubs::text_complete(&s.sandbox.data, 1).await?;
    batch::recall(&s, "general", ASK).await?;
    memory_stubs::vectors_complete(&s.sandbox.data, 2).await?;
    batch::recall(&s, "general", ASK).await?;
    memory_stubs::vectors_complete(&s.sandbox.data, 3).await?;
    s.agent.terminate().await?;
    let release = s.sandbox.root.join("embed-release");
    s.agent
        .launch
        .set_env("BUTLER_E2E_HOLD_POINT", "memory_embedding");
    s.agent.launch.set_env(
        "BUTLER_E2E_HOLD_RELEASE",
        release.to_string_lossy().into_owned(),
    );
    s.gw = s.agent.start_again().await?;
    let counts = |logs: &str| {
        (
            logs.matches("[embedding-worker] spawn_ms=").count(),
            logs.matches("[embedding-worker] initialized load_ms=")
                .count(),
        )
    };
    let before = counts(&s.agent.current_logs().await?);
    let pid = s.agent.pid().unwrap();
    let mut trace = super::drain_bounds::Trace::open(&s, 2).await?;
    let release_during_grace = async {
        trace.drain().await?;
        assert!(release.with_extension("held").exists());
        let held = usage::embedding_children(pid)?;
        if let Some(workers) = &held {
            assert_eq!(workers.len(), 1, "deadline reaped the loaded worker");
        }
        std::fs::write(&release, b"")?;
        Ok::<_, HarnessError>(held)
    };
    let (first, held) = tokio::try_join!(batch::recall(&s, "general", ASK), release_during_grace)?;
    let first_ms = recall_tool_ms(&s.sandbox.data);
    assert!(
        release.with_extension("held").exists(),
        "query embed was not sent"
    );
    assert_eq!(first["output"]["status"], "partial", "{first}");
    assert_eq!(
        first["output"]["coverage"]["vectors"]["state"], "unavailable",
        "{first}"
    );
    assert_saved_instruction(&first, &code, 3);
    assert!(first["output"]["next_cursor"].is_null(), "{first}");
    assert!(first_ms < super::recall_budget::TOTAL_MS, "{first_ms} ms");
    assert_eq!(usage::embedding_children(pid)?, held);
    assert_eq!(
        counts(&s.agent.current_logs().await?),
        (before.0 + 1, before.1 + 1)
    );
    // Draining the abandoned response must leave the protocol synchronized for
    // background work and the next query, with every new conversation indexed.
    memory_stubs::vectors_complete(&s.sandbox.data, 4).await?;
    assert_eq!(usage::embedding_children(pid)?, held);
    let warm = batch::recall(&s, "general", ASK).await?;
    scale::assert_complete(&warm, &code, 4);
    assert_eq!(usage::embedding_children(pid)?, held);
    assert_eq!(
        counts(&s.agent.current_logs().await?),
        (before.0 + 1, before.1 + 1)
    );
    eprintln!(
        "COLD-OVERRUN fallback_ms={first_ms} warm_ms={} workers=1 spawns=1 loads=1 complete_results=5",
        recall_tool_ms(&s.sandbox.data)
    );
    s.finish().await
}
