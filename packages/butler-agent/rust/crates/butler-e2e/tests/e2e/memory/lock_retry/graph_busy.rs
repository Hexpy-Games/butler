//! A real SQLite commit contention must defer a window without charging it.
use super::*;
use notify::Watcher;

#[tokio::test]
async fn mem_projection_graph_busy_recovers() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, remember, address, _observer) = start().await?;
    until(|| memory_stubs::graph_path(&s.sandbox.data).is_ok()).await;
    let graph = memory_stubs::graph_path(&s.sandbox.data)?;
    s.agent.terminate().await?;
    // A reader in rollback mode permits writes but blocks their commit. Unlike
    // a competing writer, it also permits failure settlement to start writing.
    let db = sqlite::open(&graph)?;
    let mode: String = db.query_row("PRAGMA journal_mode=DELETE", [], |r| r.get(0))?;
    assert_eq!(mode, "delete");
    drop(db);
    s.gw = s.agent.start_again().await?;
    s.select_model(&s.model).await?;
    s.provider()?.set_memory_responder(meaning);
    let gate = s.provider()?.hold_next_reply("\"speaker\":\"user\"");
    s.turn("general", &remember).await?;
    until(|| user_calls(&s) == 1).await;
    let reader = sqlite::open(&graph)?;
    reader.execute_batch("BEGIN; SELECT COUNT(*) FROM memory_projection_windows;")?;
    let window: String = reader.query_row(
        "SELECT window_ref FROM memory_projection_windows WHERE state='running' LIMIT 1",
        [],
        |r| r.get(0),
    )?;
    let journal = graph.with_file_name(format!(
        "{}-journal",
        graph.file_name().unwrap().to_str().unwrap()
    ));
    let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = send.send(event);
    })
    .map_err(|e| HarnessError(e.to_string()))?;
    watcher
        .watch(graph.parent().unwrap(), notify::RecursiveMode::NonRecursive)
        .map_err(|e| HarnessError(e.to_string()))?;
    let started = Instant::now();
    gate.release();
    // The journal is removed when the blocked commit fails and its transaction
    // rolls back. Settlement may already be writing, but its commit can safely
    // wait for this reader. No sleep guesses the SQLite busy timeout.
    tokio::time::timeout(Duration::from_secs(90), async {
        while let Some(event) = receive.recv().await {
            let event = event.map_err(|e| HarnessError(e.to_string()))?;
            if event.kind.is_remove() && event.paths.contains(&journal) {
                return Ok::<_, HarnessError>(());
            }
        }
        Err(HarnessError("journal watcher closed".into()))
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))??;
    reader.execute_batch("ROLLBACK")?;
    drop(reader);
    drop(watcher);
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
