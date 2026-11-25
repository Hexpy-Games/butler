//! A real SQLite commit contention must defer a window without charging it.
use super::*;

#[tokio::test]
async fn mem_projection_graph_busy_recovers() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, remember, address, _observer) = start().await?;
    until(|| memory_stubs::graph_path(&s.sandbox.data).is_ok()).await;
    let graph = memory_stubs::graph_path(&s.sandbox.data)?;
    s.select_model(&s.model).await?;
    s.provider()?.set_memory_responder(meaning);
    let gate = s.provider()?.hold_next_reply("\"speaker\":\"user\"");
    s.turn("general", &remember).await?;
    until(|| user_calls(&s) == 1).await;
    // A competing writer blocks the result write in WAL mode too.
    let holder = sqlite::open(&graph)?;
    holder.busy_timeout(butler_memory::cognition::GRAPH_BUSY_TIMEOUT)?;
    holder.execute_batch("BEGIN IMMEDIATE")?;
    let window: String = holder.query_row(
        "SELECT window_ref FROM memory_projection_windows WHERE state='running' LIMIT 1",
        [],
        |r| r.get(0),
    )?;
    let started = Instant::now();
    gate.release();
    // Hold past the result write's busy failure and release inside
    // settlement's own busy wait, so only settlement can write.
    tokio::time::sleep(butler_memory::cognition::GRAPH_BUSY_TIMEOUT * 3 / 2).await;
    holder.execute_batch("ROLLBACK")?;
    drop(holder);
    until(|| window_count(&graph, &window, "state IN ('pending','failed')") == 1).await;
    let outcome: (String, Option<String>, Option<String>) = sqlite::open(&graph)?.query_row(
        "SELECT state,error_code,next_attempt_at FROM memory_projection_windows WHERE window_ref=?1",
        [&window],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    eprintln!(
        "MEM-GRAPH-BUSY outcome={outcome:?} contention_ms={}",
        started.elapsed().as_millis()
    );
    assert_eq!(
        outcome,
        (
            "pending".into(),
            Some("memory_write_busy".into()),
            Some("2026-10-02T04:01:30.000Z".into())
        )
    );
    assert_eq!(charged_attempts(&graph, &window)?, 0);
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(
        user_calls(&s),
        1,
        "retry must respect the existing deadline"
    );
    jump_to(address, "2026-10-02T04:04:00.000Z".into()).await?;
    wake_source(&s.sandbox.data)?;
    until(|| window_count(&graph, &window, "state IN ('complete','failed')") == 1).await;
    assert_applied_once(&graph, &window)?;
    eprintln!(
        "MEM-GRAPH-BUSY complete=true charged=0 recovery_ms={}",
        started.elapsed().as_millis()
    );
    s.finish().await
}
