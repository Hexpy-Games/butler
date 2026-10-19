//! MEM-COVERAGE-SCALE: at owner scale, recall reads projection coverage from
//! the inventory mirror without scanning the canonical store, and returns
//! the same coverage and results as the full scan, including a change the
//! mirror has not applied yet.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use super::coverage_support::{
    Variant, canonical, coverage, graph, hide_mirror, hold_gate, mirror_current, pending,
    published, recall, release_gate, session, show_mirror, start, turn,
};
use butler_e2e::e2e::HarnessError;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const SESSION: &str = "coverage-scale";
const PROJECT: &str = "coverage-scale-project";
/// Canonical turns in the scale chat (each with a request and an answer).
const TURNS: u64 = 10_000;
/// Candidate selection (graph read stage) per recall, debug build, on a
/// loaded machine. Reading the mirror measured 20-170 ms here (its inventory
/// part about 2 ms); the full scan of this fixture measured 2.0-2.6 s.
const SELECTION_BUDGET_MS: f64 = 400.0;
const WORD: &str = "zephyrquartz";

fn variant() -> Variant {
    Variant {
        prompt: "Coverage recall at owner scale.",
        arguments: json!({"cue":WORD,"session_ids":[SESSION],"include_vector":false}),
    }
}

fn turns() -> u64 {
    std::env::var("BUTLER_E2E_COVERAGE_TURNS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(TURNS)
}

fn seed(data: &std::path::Path, count: u64) {
    let mut db = canonical(data);
    let tx = db.transaction().unwrap();
    session(&tx, SESSION, Some(PROJECT));
    for n in 1..=count {
        let text = if n == 1 {
            format!("The archive word is {WORD}.")
        } else {
            format!("Scale fact number {n} about routine {}.", n % 97)
        };
        let day = 1 + n % 28;
        turn(
            &tx,
            SESSION,
            n,
            &text,
            &format!("2026-02-{day:02}T00:00:00.000Z"),
        );
    }
    published(&tx);
    tx.commit().unwrap();
}

/// Completes the projection of every mirrored source: registered jobs are
/// marked complete; unregistered sources get a completed chunk and job.
fn project_everything(data: &std::path::Path) {
    graph(data).execute_batch(r#"
        UPDATE memory_projection_jobs SET semantic_graph_state='{"state":"complete"}'
          WHERE json_extract(semantic_graph_state,'$.state')!='complete';
        INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,origin_kind,status,source_hash,created_at,updated_at)
          SELECT episode_id,'conversation_turn:'||entity_id,revision,'user_input','active','seed','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'
          FROM memory_canonical_inventory i WHERE eligible=1 AND covered=0
            AND NOT EXISTS(SELECT 1 FROM memory_chunks c WHERE c.memory_chunk_id=i.episode_id);
        INSERT INTO memory_projection_jobs(job_id,episode_id,revision,extraction_version,generation,extraction_model,reasoning_effort,observed_completion_job_ids,source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,created_at)
          SELECT 'scale-'||episode_id,episode_id,revision,'v3','synthetic','stub','low','[]','{"state":"complete"}','{"state":"complete"}','{"state":"complete"}','{"state":"complete"}','{"state":"complete"}','2026-02-01T00:00:00Z'
          FROM memory_canonical_inventory WHERE eligible=1 AND covered=0;
    "#).unwrap();
    let uncovered: i64 = graph(data)
        .query_row("SELECT COUNT(*) FROM memory_canonical_inventory WHERE eligible=1 AND covered=0 AND session_id=?1", [SESSION], |row| row.get(0))
        .unwrap();
    assert_eq!(uncovered, 0);
}

fn episodes(output: &Value) -> Vec<Value> {
    output["output"]["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|result| json!([result["episode_ref"], result["revision"]]))
        .collect()
}

#[tokio::test]
async fn mem_coverage_scale_reads_the_mirror() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let count = turns();
    let s = start("MEM-COVERAGE-SCALE", &[variant()]).await?;
    let data = s.sandbox.data.clone();
    s.turn("general", variant().prompt).await?;
    let seeded = Instant::now();
    seed(&data, count);
    eprintln!(
        "MEM-COVERAGE-SCALE seeded turns={count} ms={}",
        seeded.elapsed().as_millis()
    );
    let built = Instant::now();
    tokio::time::timeout(Duration::from_secs(600), async {
        while !mirror_current(&data) {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("inventory mirror was not built");
    eprintln!(
        "MEM-COVERAGE-SCALE mirror_build_ms={}",
        built.elapsed().as_millis()
    );
    let gate = hold_gate(&data);
    project_everything(&data);

    let (mirror, mirror_ms) = recall(&s, &variant()).await?;
    let phase = hide_mirror(&data);
    let (full, full_ms) = recall(&s, &variant()).await?;
    show_mirror(&data, &phase);
    eprintln!(
        "MEM-COVERAGE-SCALE turns={count} selection_ms mirror={mirror_ms:.1} full_scan={full_ms:.1}"
    );
    // Every source is projected: the mirror reading is complete.
    assert_eq!(
        coverage(&mirror),
        json!({"status":"complete",
            "graph":{"state":"ok","candidates":1,"codes":[]},
            "source":{"state":"ok","candidates":2,"codes":[]}}),
        "{mirror}"
    );
    assert_eq!(episodes(&mirror).len(), 1, "{mirror}");
    assert!(
        mirror["output"]["results"].to_string().contains(WORD),
        "registered source not recalled: {mirror}"
    );
    // The full scan reads the same stores; at owner scale its inventory
    // runs into the candidate deadline and reports itself partial.
    if full["output"]["coverage"]["source"]["codes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|code| code == "ingestion_inventory_partial")
    {
        assert!(full_ms > SELECTION_BUDGET_MS);
    } else {
        assert_eq!(coverage(&mirror), coverage(&full));
    }
    assert_eq!(episodes(&mirror), episodes(&full));

    // A turn the mirror has not applied yet is still reported.
    turn(
        &canonical(&data),
        SESSION,
        count + 1,
        &format!("Latest {WORD} note."),
        "2026-02-28T00:00:00.000Z",
    );
    let (latest, latest_ms) = recall(&s, &variant()).await?;
    eprintln!("MEM-COVERAGE-SCALE latest selection_ms={latest_ms:.1}");
    assert!(
        pending(&latest),
        "unprojected latest turn missing from coverage: {latest}"
    );
    assert_eq!(episodes(&latest), episodes(&mirror));
    if count >= TURNS {
        assert!(mirror_ms < SELECTION_BUDGET_MS && latest_ms < SELECTION_BUDGET_MS);
        assert!(
            full_ms > SELECTION_BUDGET_MS,
            "fixture too small to tell the paths apart"
        );
    }
    release_gate(&gate);
    s.finish().await
}
