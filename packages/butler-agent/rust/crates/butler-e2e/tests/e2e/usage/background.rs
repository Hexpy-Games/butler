//! USE-01's durable extraction barrier and per-window evidence (#1029).
use butler_e2e::e2e::{HarnessError, gateway::Reply, scenario::Scenario};
use butler_platform::sqlite;
use rusqlite::OptionalExtension;
use serde_json::Value;
use std::{path::Path, time::Duration};

pub(super) async fn wait(s: &Scenario, turn: &str) -> Result<Reply, HarnessError> {
    tokio::time::timeout(Duration::from_secs(10), async {
        let active: Value = serde_json::from_slice(
            &tokio::fs::read(
                s.sandbox
                    .data
                    .join("cognition/memory/active-generation.json"),
            )
            .await?,
        )?;
        let graph = s
            .sandbox
            .data
            .join("cognition/memory/generations")
            .join(active["generation_id"].as_str().unwrap())
            .join("graph.sqlite");
        loop {
            let path = graph.clone();
            let turn = turn.to_owned();
            let revision = tokio::task::spawn_blocking(move || completed_revision(&path, &turn))
                .await
                .map_err(|error| butler_e2e::e2e::harness_error(error.to_string()))??;
            if let Some(revision) = revision {
                let monitor = s.gw.get("/usage-monitor?since_hours=1").await?;
                let scope = format!("memory-extract:{revision}:meaning");
                assert_eq!(
                    monitor.data()["model"]["byScopeUsage"][&scope]["requestCount"],
                    2,
                    "{}",
                    monitor.text
                );
                return Ok::<_, HarnessError>(monitor);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|_| butler_e2e::e2e::harness_error("background extraction usage did not complete"))?
}

fn completed_revision(graph: &Path, turn: &str) -> Result<Option<String>, HarnessError> {
    let db = sqlite::open_with_flags(graph, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let job = db
        .query_row(
            "SELECT j.job_id,j.revision FROM memory_chunks c \
             JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id \
             WHERE c.source_key=?1 AND json_extract(j.semantic_graph_state,'$.state')='complete'",
            [format!("conversation_turn:{turn}")],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let Some((job, revision)) = job else {
        return Ok(None);
    };
    let mut statement = db.prepare(
        "SELECT w.window_ref,w.source_refs_json,w.state,w.attempt_count,s.role \
         FROM memory_projection_windows w \
         JOIN memory_chunk_sources s ON s.source_id=json_extract(w.source_refs_json,'$[0]') \
         WHERE w.job_id=?1 ORDER BY w.ordinal",
    )?;
    let windows = statement
        .query_map([job], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    eprintln!("USE-01 revision={revision} windows={windows:?}");
    assert_eq!(windows.len(), 2, "{windows:?}");
    assert_ne!(windows[0].0, windows[1].0);
    assert_ne!(windows[0].1, windows[1].1);
    let mut roles: Vec<_> = windows.iter().map(|window| window.4.as_str()).collect();
    roles.sort_unstable();
    assert_eq!(roles, ["assistant", "user"]);
    for (_, sources, state, attempts, _) in &windows {
        assert_eq!(serde_json::from_str::<Vec<String>>(sources)?.len(), 1);
        assert_eq!(state, "complete");
        assert_eq!(*attempts, 1);
    }
    Ok(Some(revision))
}
