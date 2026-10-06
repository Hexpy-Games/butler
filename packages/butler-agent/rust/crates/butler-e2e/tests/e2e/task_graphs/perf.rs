//! PERF-TASK-GRAPH: full HTTP responses at owner scale, p99 <50ms.
use super::super::data_perf::wal;
use super::*;
use std::time::{Duration, Instant};

#[tokio::test]
async fn perf_task_graph_endpoints_owner_scale() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        std::env::var("BUTLER_E2E_TIER").as_deref() == Ok("perf"),
        "requires perf tier and release agent"
    );
    let mut s = Setup::new("PERF-TASK-GRAPH")?.start().await?;
    let created = s.gw.post("/sessions", json!({"kind":"chat"})).await?;
    let chat = created.data()["session"]["id"].as_str().unwrap().to_owned();
    let hint = created.data()["session"]["session_hint"]
        .as_str()
        .unwrap()
        .to_owned();
    s.agent.terminate().await?;
    fixture::seed(&s.sandbox.data, &hint, 6)?;
    let bytes = super::scale::seed(&s.sandbox.data)?;
    s.gw = s.agent.start_again().await?;
    tokio::time::sleep(Duration::from_secs(10)).await;
    super::scale::assert_indexes(&s.sandbox.data)?;
    let pins = [
        "agent-runtime/btcc.sqlite",
        "app-server/butler-client.sqlite",
    ]
    .map(|path| wal::Wal::pin(&s.sandbox.data, path))
    .into_iter()
    .collect::<Result<Vec<_>, _>>()?;
    let before = pins
        .iter()
        .map(wal::Wal::sample)
        .collect::<Result<Vec<_>, _>>()?;
    for (path, kind) in [
        (format!("/sessions/{chat}/task-graphs"), "list"),
        ("/plans/graph-6-0/task-graph".into(), "graph"),
        ("/tasks/task-6-0-a/document".into(), "document"),
    ] {
        measure(&s, &path, kind, bytes).await?;
    }
    tokio::time::sleep(Duration::from_secs(60)).await;
    for (pin, before) in pins.iter().zip(before) {
        assert_eq!(
            pin.delta(before)?,
            (0, 0),
            "{}: reads/idle wrote WAL",
            pin.name
        );
    }
    eprintln!("PERF-TASK-GRAPH endpoint+idle60s wal_bytes=0 commits=0");
    super::scale::assert_indexes(&s.sandbox.data)?;
    drop(pins);
    s.finish().await
}

async fn measure(
    s: &butler_e2e::e2e::scenario::Scenario,
    path: &str,
    kind: &str,
    bytes: u64,
) -> Result<(), HarnessError> {
    let mut samples = Vec::new();
    for _ in 0..200 {
        let start = Instant::now();
        let reply = s.gw.get(path).await?;
        samples.push(start.elapsed());
        assert_eq!(reply.status, 200, "{}", reply.text);
        match kind {
            "list" => {
                assert_eq!(reply.data()["total"], 6);
                assert_eq!(reply.data()["graphs"].as_array().unwrap().len(), 6);
                assert_eq!(reply.data()["graphs"][0]["counts"]["total"], 5);
            }
            "graph" => assert_graph(reply.data(), 6),
            _ => {
                assert_eq!(reply.data()["id"], "task-6-0-a");
                assert!(
                    reply.data()["markdown"]
                        .as_str()
                        .unwrap()
                        .contains("All checks pass")
                );
            }
        }
    }
    samples.sort();
    let p99 = samples[197];
    eprintln!(
        "PERF-TASK-GRAPH db_bytes={bytes} endpoint={kind} samples=200 p50={:?} p99={p99:?}",
        samples[99]
    );
    butler_e2e::assert_wall_clock_budget!(p99, Duration::from_millis(50), kind);
    Ok(())
}
