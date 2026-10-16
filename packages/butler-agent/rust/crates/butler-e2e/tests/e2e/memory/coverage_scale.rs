//! MEM-COVERAGE-SCALE: at owner scale, recall reads projection coverage from
//! the inventory mirror without scanning the canonical store: with every
//! source projected, with half of them still waiting for projection, and
//! with a change the mirror has not applied yet. Coverage and results are
//! asserted complete and equal to the full scan's where it finishes.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use super::coverage_seed::{published, session, turn};
use super::coverage_support::{
    Variant, canonical, chats, coverage, graph, hide_mirror, hold_gate, mirror_current, pending,
    recall_in, release_gate, show_mirror, start,
};
use butler_e2e::e2e::HarnessError;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

/// Projected chat and its project.
const DONE: &str = "coverage-scale-done";
const DONE_PROJECT: &str = "coverage-scale-done-project";
/// Chat whose sources still wait for projection, in another project.
const BACKLOG: &str = "coverage-scale-backlog";
const BACKLOG_PROJECT: &str = "coverage-scale-backlog-project";
/// A small projected chat: the full scan still reads the whole store, yet
/// stays within the candidate deadline, so its coverage is compared.
const SMALL: &str = "coverage-scale-small";
/// Canonical turns in all (each with a request and an answer), half per chat.
const TURNS: u64 = 10_000;
/// Candidate selection (graph read stage) per recall, debug build, on a
/// loaded machine; the full scan of the projected half is reported.
const SELECTION_BUDGET_MS: f64 = 400.0;
/// From seeding to a mirror current with the store, with catch-up
/// registering the same sources at the same time.
const BUILD_BUDGET: Duration = Duration::from_secs(120);
const WORD: &str = "zephyrquartz";

fn variants() -> Vec<Variant> {
    let arguments = |extra: Value| {
        let mut base = json!({"cue":WORD,"include_vector":false});
        base.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        base
    };
    vec![
        Variant {
            prompt: "Coverage recall of the projected chat.",
            arguments: arguments(json!({"session_ids":[DONE]})),
        },
        Variant {
            prompt: "Coverage recall of both chats.",
            arguments: arguments(json!({"session_ids":[DONE,BACKLOG]})),
        },
        Variant {
            prompt: "Coverage recall of the projected project.",
            arguments: arguments(json!({"project_filter":"selected","project_ids":[DONE_PROJECT]})),
        },
        Variant {
            prompt: "Coverage recall of the small chat.",
            arguments: arguments(json!({"session_ids":[SMALL]})),
        },
    ]
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
    session(&tx, DONE, Some(DONE_PROJECT));
    session(&tx, BACKLOG, Some(BACKLOG_PROJECT));
    for n in 1..=count {
        let chat = if n % 2 == 1 { DONE } else { BACKLOG };
        let text = if n == 1 {
            format!("The archive word is {WORD}.")
        } else {
            format!("Scale fact number {n} about routine {}.", n % 97)
        };
        let at = format!("2026-02-{:02}T00:00:00.000Z", 1 + n % 28);
        turn(&tx, chat, n, &text, &at);
    }
    session(&tx, SMALL, None);
    for n in 1..=20 {
        let at = format!("2026-02-{n:02}T00:00:00.000Z");
        turn(&tx, SMALL, n, &format!("Small chat fact {n}."), &at);
    }
    published(&tx);
    tx.commit().unwrap();
}

/// Completes the projection of every mirrored source of the projected chat
/// and leaves every source of the backlog chat waiting: its registered jobs
/// pending, its other sources unregistered.
fn project_done_chat(data: &std::path::Path) {
    graph(data).execute(r#"
        UPDATE memory_projection_jobs SET semantic_graph_state=CASE WHEN episode_id IN
          (SELECT episode_id FROM memory_canonical_inventory WHERE session_id IN (?1,?3))
          THEN '{"state":"complete"}' ELSE '{"state":"pending"}' END
        WHERE episode_id IN (SELECT episode_id FROM memory_canonical_inventory WHERE session_id IN (?1,?2,?3))"#,
        [DONE, BACKLOG, SMALL],
    ).unwrap();
    graph(data).execute_batch(&format!(r#"
        INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,origin_kind,status,source_hash,created_at,updated_at)
          SELECT episode_id,'conversation_turn:'||entity_id,revision,'user_input','active','seed','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'
          FROM memory_canonical_inventory i WHERE eligible=1 AND covered=0 AND session_id IN ('{DONE}','{SMALL}')
            AND NOT EXISTS(SELECT 1 FROM memory_chunks c WHERE c.memory_chunk_id=i.episode_id);
        INSERT INTO memory_projection_jobs(job_id,episode_id,revision,extraction_version,generation,extraction_model,reasoning_effort,observed_completion_job_ids,source_state,semantic_graph_state,episode_vectors_state,node_vectors_state,hot_cache_state,created_at)
          SELECT 'scale-'||episode_id,episode_id,revision,'v3','synthetic','stub','low','[]','{{"state":"complete"}}','{{"state":"complete"}}','{{"state":"complete"}}','{{"state":"complete"}}','{{"state":"complete"}}','2026-02-01T00:00:00Z'
          FROM memory_canonical_inventory WHERE eligible=1 AND covered=0 AND session_id IN ('{DONE}','{SMALL}');
    "#)).unwrap();
    let uncovered = |chat: &str| -> i64 {
        graph(data)
            .query_row("SELECT COUNT(*) FROM memory_canonical_inventory WHERE eligible=1 AND covered=0 AND session_id=?1", [chat], |row| row.get(0))
            .unwrap()
    };
    assert_eq!(uncovered(DONE), 0);
    assert_eq!(uncovered(SMALL), 0);
    assert_eq!(uncovered(BACKLOG), i64::try_from(turns() / 2).unwrap());
}

fn episodes(output: &Value) -> Vec<Value> {
    output["output"]["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|result| json!([result["episode_ref"], result["revision"]]))
        .collect()
}

fn complete() -> Value {
    json!({"status":"complete",
        "graph":{"state":"ok","candidates":1,"codes":[]},
        "source":{"state":"ok","candidates":2,"codes":[]}})
}

#[tokio::test]
async fn mem_coverage_scale_reads_the_mirror() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let count = turns();
    let s = start("MEM-COVERAGE-SCALE", &variants()).await?;
    let data = s.sandbox.data.clone();
    let chats = chats(&s, 5).await?;
    s.turn("general", variants()[0].prompt).await?;
    seed(&data, count);
    let built = Instant::now();
    tokio::time::timeout(Duration::from_secs(600), async {
        while !mirror_current(&data) {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("inventory mirror was not built");
    let build = built.elapsed();
    let gate = hold_gate(&data);
    project_done_chat(&data);
    let v = variants();

    let (projected, projected_ms) = recall_in(&s, &chats[0], &v[0]).await?;
    assert_eq!(coverage(&projected), complete(), "{projected}");
    assert_eq!(episodes(&projected).len(), 1, "{projected}");
    assert!(
        projected["output"]["results"].to_string().contains(WORD),
        "{projected}"
    );
    let (backlog, backlog_ms) = recall_in(&s, &chats[1], &v[1]).await?;
    assert!(
        pending(&backlog),
        "the waiting chat is not reported: {backlog}"
    );
    assert_eq!(
        backlog["output"]["coverage"]["graph"]["codes"],
        json!(["ingestion_pending"])
    );
    assert_eq!(episodes(&backlog), episodes(&projected));
    let (project, project_ms) = recall_in(&s, &chats[2], &v[2]).await?;
    assert_eq!(coverage(&project), complete(), "{project}");
    assert_eq!(episodes(&project), episodes(&projected));

    let phase = hide_mirror(&data);
    let (full, full_ms) = recall_in(&s, &chats[3], &v[0]).await?;
    show_mirror(&data, &phase);
    assert_eq!(episodes(&full), episodes(&projected));
    // The full scan reads the same stores; when it outruns the candidate
    // deadline it can only report its inventory partial.
    let cut = json!(["ingestion_inventory_partial"]);
    let done_cut = full["output"]["coverage"]["source"]["codes"] == cut;
    if done_cut {
        assert_eq!(
            full["output"]["coverage"]["graph"]["codes"][0], cut[0],
            "{full}"
        );
    } else {
        assert_eq!(coverage(&full), coverage(&projected), "{full}");
    }
    // The small chat's full scan finishes in time: its coverage is compared.
    let (small, _) = recall_in(&s, &chats[4], &v[3]).await?;
    let phase = hide_mirror(&data);
    let (small_full, small_full_ms) = recall_in(&s, &chats[4], &v[3]).await?;
    show_mirror(&data, &phase);
    assert_ne!(
        small_full["output"]["coverage"]["source"]["codes"], cut,
        "{small_full}"
    );
    assert_eq!(coverage(&small_full), coverage(&small), "{small_full}");
    assert!(!pending(&small), "{small}");
    eprintln!(
        "MEM-COVERAGE-SCALE full_scan_branch projected_chat={} small_chat=compared small_full_scan_ms={small_full_ms:.1}",
        if done_cut {
            "deadline_partial"
        } else {
            "compared"
        }
    );

    // A turn the mirror has not applied yet is still reported.
    let at = "2026-02-28T00:00:00.000Z";
    turn(
        &canonical(&data),
        DONE,
        count + 1,
        &format!("Latest {WORD} note."),
        at,
    );
    let (latest, latest_ms) = recall_in(&s, &chats[0], &v[0]).await?;
    assert!(
        pending(&latest),
        "unprojected latest turn missing from coverage: {latest}"
    );
    assert_eq!(episodes(&latest), episodes(&projected));
    eprintln!(
        "MEM-COVERAGE-SCALE turns={count} build_ms={} selection_ms projected={projected_ms:.1} backlog={backlog_ms:.1} \
         project_with_backlog={project_ms:.1} latest={latest_ms:.1} full_scan={full_ms:.1} full_scan_codes={}",
        build.as_millis(),
        full["output"]["coverage"]["source"]["codes"]
    );
    if count >= TURNS {
        assert!(build < BUILD_BUDGET, "mirror build took {build:?}");
        for ms in [projected_ms, backlog_ms, project_ms, latest_ms] {
            assert!(ms < SELECTION_BUDGET_MS, "selection took {ms} ms");
        }
    }
    release_gate(&gate);
    s.finish().await
}
