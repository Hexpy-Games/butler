//! MEM-HOT-ACTIVE: live refresh without embeddings and migrated-cache retention.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::fake_servers::{ChatBehavior, FakeServer, LOCAL_MODEL};
use butler_e2e::e2e::scenario::{Fixture, Setup};
use butler_e2e::e2e::{HarnessError, fixtures};
use butler_platform::sqlite;
use rusqlite::OpenFlags;
use serde_json::{Value, json};
use std::path::Path;

const FACT: &str = "My preferred garden flower is the blue iris.";
const NOW: &str = "2026-10-02T04:01:00.000Z";

fn readonly(path: &Path) -> butler_platform::sqlite::Connection {
    sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
}

// Await durable state, never an elapsed delay. The timeout is a harness failure
// guard, not a product latency assertion.
async fn until(mut ready: impl FnMut() -> bool) {
    tokio::time::timeout(std::time::Duration::from_secs(90), async {
        while !ready() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("memory job did not reach its durable completion barrier");
}

fn cache_complete(graph: &Path, turn: &str) -> bool {
    readonly(graph).query_row("SELECT COUNT(*) FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE c.source_key=?1 AND json_extract(j.semantic_graph_state,'$.state')='complete' AND json_extract(j.hot_cache_state,'$.state')='complete'", [format!("conversation_turn:{turn}")], |row| row.get::<_, i64>(0)).unwrap() == 1
}

fn hot_documents(data: &Path) -> Vec<String> {
    let db = readonly(&data.join("agent-runtime/btcc.sqlite"));
    db.prepare("SELECT content FROM btcc_context_documents WHERE source_id='hot-cache' AND projection_class='optional_hot_cache' ORDER BY context_ref")
        .unwrap().query_map([], |row| row.get(0)).unwrap()
        .map(Result::unwrap).collect()
}

fn hot_cache_of(data: &Path, turn_id: &str) -> Vec<String> {
    let db = readonly(&data.join("agent-runtime/btcc.sqlite"));
    db.prepare(
        "SELECT d.content FROM btcc_turns t, json_each(t.context_json, '$.optionalHotCacheRefs') r JOIN btcc_context_documents d ON d.context_ref=r.value WHERE t.turn_id=?1 AND d.source_id='hot-cache'"
    ).unwrap().query_map([turn_id], |row| row.get(0)).unwrap().map(Result::unwrap).collect()
}

/// The daily cycle also composes the briefing and standing sheet with the memory model;
/// only the cache refresh itself must stay free of model calls.
fn non_daily_memory_calls(server: &FakeServer) -> usize {
    server
        .chat_requests()
        .iter()
        .filter(|request| {
            let text = request.to_string();
            !text.contains("_new_chat_briefing")
                && !text.contains("You keep a short fact sheet about one person")
        })
        .count()
}

#[tokio::test]
async fn mem_hot_active_refresh_reaches_another_chat() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    // Two more statements that together pass the 1 KiB entry cap: the entry
    // keeps whole statements in order and stops before the one that does not fit.
    let kept = "Alpha note. ".repeat(50);
    let cut = "Beta note. ".repeat(55);
    let answer = json!({"status":"processed","entities":[],"items":[
            {"kind":"preference","subject":null,"text":FACT,"evidence":[0]},
            {"kind":"fact","subject":null,"text":kept,"evidence":[0]},
            {"kind":"fact","subject":null,"text":cut,"evidence":[0]}
        ],"attributes":[]})
    .to_string();
    let server = FakeServer::local_models(ChatBehavior {
        answer: answer.clone(),
        chunk_delay: std::time::Duration::ZERO,
        ..ChatBehavior::default()
    })
    .await?;
    let setup = Setup::new("MEM-HOT-ACTIVE")?
        .fixture(Fixture::Empty)
        .env("BUTLER_E2E_APP_NOW", NOW)
        .env(
            "BUTLER_E2E_EMBED_MANIFEST",
            format!("{}/unavailable", server.base_url),
        );
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    fixtures::scheduler_ran_today(&setup.sandbox.data, NOW)?;
    let mut s = setup.start().await?;
    let descriptor = s
        .sandbox
        .data
        .join("cognition/memory/active-generation.json");
    until(|| descriptor.exists()).await;
    let active: Value = serde_json::from_slice(&std::fs::read(&descriptor)?)?;
    let generation = s
        .sandbox
        .data
        .join("cognition/memory/generations")
        .join(active["generation_id"].as_str().unwrap());
    let graph = generation.join("graph.sqlite");
    let cache = generation.join("hot/cache.md");
    let before = match std::fs::read(&cache) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.into()),
    };
    let reply =
        s.gw.post(
            "/model-catalog/local-models",
            json!({
                "provider_id":"local","api_type":"openai_compatible","platform":"ollama",
                "server_url":server.base_url,"model_id":LOCAL_MODEL,"display_name":LOCAL_MODEL,
                "context_window_tokens":131_072,"source":"discovered"
            }),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let model = reply.data()["model"]["model_ref"]
        .as_str()
        .unwrap()
        .to_owned();
    let reply =
        s.gw.patch(
            "/settings",
            json!({
                "model":model,"consolidation_model":model,"access_mode":"full_access"
            }),
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let (turn_id, turn) = s.turn("general", FACT).await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    until(|| readonly(&graph).query_row(
        "SELECT COUNT(*) FROM memory_chunks WHERE source_key=?1 AND summary_status='complete' AND summary LIKE '%blue iris%'",
        [format!("conversation_turn:{turn_id}")], |row| row.get::<_, i64>(0)).unwrap() == 1).await;
    until(|| cache_complete(&graph, &turn_id)).await;
    let refreshed = std::fs::read(&cache)?;
    assert_eq!(
        butler_platform::secure_fs::is_owner_only(&std::fs::metadata(&cache)?),
        butler_platform::secure_fs::OWNER_ONLY.then_some(true),
        "hot cache privacy"
    );
    let refreshed_modified = std::fs::metadata(&cache)?.modified()?;
    assert_ne!(before, refreshed, "cache must refresh before restart");
    assert!(String::from_utf8_lossy(&refreshed).contains("blue iris"));
    let status = s.agent.launch.command().arg("status").output()?;
    assert!(status.status.success());
    let status = String::from_utf8(status.stdout).unwrap();
    let memory_tokens = status
        .lines()
        .find_map(|line| line.strip_prefix("memory: "))
        .unwrap()
        .replace(',', "")
        .parse::<usize>()
        .unwrap();
    let cache_tokens = String::from_utf8_lossy(&refreshed)
        .encode_utf16()
        .count()
        .div_ceil(4);
    assert!(
        memory_tokens >= cache_tokens,
        "status omitted the active cache: {status}"
    );

    let first_documents = hot_documents(&s.sandbox.data);

    // Restart drives the first maintenance tick immediately after readiness.
    // Clear only our fixture's daily markers, with a fixed clock after 04:00.
    s.agent.terminate().await?;
    // Migration retains physical entries without outcome rows. Re-run the real
    // stage with no new window summary; it must keep the valid installed fact.
    let db = sqlite::open(&graph).unwrap();
    db.execute("DELETE FROM memory_hot_cache_outcomes", [])
        .unwrap();
    db.execute("UPDATE memory_projection_windows SET output_json=json_remove(output_json,'$.summary') WHERE job_id IN (SELECT j.job_id FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE c.source_key=?1)", [format!("conversation_turn:{turn_id}")]).unwrap();
    db.execute("UPDATE memory_projection_jobs SET hot_cache_state='{\"state\":\"pending\"}' WHERE episode_id IN (SELECT memory_chunk_id FROM memory_chunks WHERE source_key=?1)", [format!("conversation_turn:{turn_id}")]).unwrap();
    db.close().unwrap();
    for job in ["session-sync", "consolidation-cycle"] {
        std::fs::remove_file(s.sandbox.data.join(format!("state/scheduler/{job}.json")))?;
    }
    // A sheet from the previous format counts as empty and is rebuilt.
    std::fs::write(
        generation.join("hot/standing.md"),
        "<!-- butler-standing {\"v\":1,\"through_at\":\"\",\"through_id\":\"\",\"sources\":0,\"model\":\"old\",\"updated_at\":\"2026-10-01T00:00:00Z\"} -->\nOld sheet line.",
    )?;
    super::memory_fixture::arm_consolidation(&s.sandbox.data, "2026-10-02T03:59:00.000Z")?;
    // Seed dormant Box data after initialization, including an expired item and
    // an invalid index. Daily maintenance must neither validate nor rewrite it.
    let box_root = s.sandbox.data.join("cognition/box");
    std::fs::create_dir_all(box_root.join("items/box_expired"))?;
    std::fs::write(
        box_root.join("items/box_expired/manifest.json"),
        br#"{"box_item_id":"box_expired","retention":{"expires_at":"2020-01-01T00:00:00Z"}}"#,
    )?;
    std::fs::write(box_root.join("index.sqlite"), b"dormant index\0\xff")?;
    let box_before = box_snapshot(&box_root)?;
    let calls_before_refresh = non_daily_memory_calls(&server);
    s.gw = s.agent.start_again().await?;
    until(|| {
        ["session-sync", "consolidation-cycle"].iter().all(|job| {
            std::fs::read(s.sandbox.data.join(format!("state/scheduler/{job}.json")))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .is_some_and(|state| state["lastRunDate"] == NOW[..10])
        })
    })
    .await;
    until(|| cache_complete(&graph, &turn_id)).await;
    assert_eq!(
        non_daily_memory_calls(&server),
        calls_before_refresh,
        "cache-only refresh made a model call"
    );
    assert_eq!(
        String::from_utf8_lossy(&refreshed),
        std::fs::read_to_string(&cache)?,
        "valid migrated cache entry was lost during an empty refresh"
    );
    assert_eq!(
        refreshed_modified,
        std::fs::metadata(&cache)?.modified()?,
        "unchanged refresh replaced cache"
    );
    let sync: Value = serde_json::from_slice(&std::fs::read(
        s.sandbox.data.join("state/scheduler/session-sync.json"),
    )?)?;
    assert_eq!(sync["status"], "ok", "{sync}");
    let cycle: Value = serde_json::from_slice(&std::fs::read(
        s.sandbox
            .data
            .join("state/scheduler/consolidation-cycle.json"),
    )?)?;
    assert_eq!(cycle["status"], "ok", "{cycle}");
    until(|| {
        std::fs::read_to_string(generation.join("hot/standing.md"))
            .is_ok_and(|text| text.contains("\"v\":2"))
    })
    .await;
    let logs = s.sandbox.data.join("cognition/consolidation/logs");
    let events: Vec<Value> = std::fs::read_dir(logs)?
        .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap())
        .flat_map(|text| {
            text.lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect::<Vec<Value>>()
        })
        .collect();
    let standing: Vec<_> = events
        .iter()
        .filter(|event| event["phase"] == "standing_facts")
        .collect();
    assert_eq!(standing.len(), 1, "{events:?}");
    let standing = standing[0];
    assert_eq!(standing["status"], "ok", "{standing}");
    assert_eq!(standing["metrics"]["calls"], 1, "{standing}");
    assert!(
        standing["metrics"]["sources_folded"].as_u64().unwrap() >= 1,
        "{standing}"
    );
    assert!(
        standing["metrics"]["lines_added"].as_u64().unwrap() >= 1,
        "{standing}"
    );
    assert!(
        standing["metrics"]["bytes"].as_u64().unwrap() > 0,
        "{standing}"
    );
    for event in events.iter().filter(|event| event["phase"] == "health") {
        assert!(
            event["metrics"]["memory_chunks_count"].as_i64().unwrap() >= 1,
            "{event}"
        );
    }
    assert!(
        events.iter().all(|event| event["phase"] != "consolidate"),
        "{events:?}"
    );
    let optimize = events
        .iter()
        .find(|event| event["phase"] == "optimize")
        .unwrap();
    assert!(
        optimize["metrics"].get("caches_compacted").is_none(),
        "{optimize}"
    );
    assert!(server.chat_requests().iter().any(|request| {
        let text = request.to_string();
        text.contains("You keep a short fact sheet about one person")
            && text.contains("] My preferred garden flower is the blue iris.")
            && text.contains("Current sheet (0 bytes; keep it under 3,000)")
    }));
    assert_eq!(
        box_snapshot(&box_root)?,
        box_before,
        "daily cycle changed dormant Box paths, bytes or modification times"
    );
    let summary = s
        .sandbox
        .data
        .join("cognition/consolidation/run-summary.jsonl");
    assert_eq!(
        butler_platform::secure_fs::is_owner_only(&std::fs::metadata(&summary)?),
        butler_platform::secure_fs::OWNER_ONLY.then_some(true),
        "maintenance summary privacy"
    );
    for job in ["session-sync", "consolidation-cycle"] {
        assert_eq!(
            butler_platform::secure_fs::is_owner_only(&std::fs::metadata(
                s.sandbox.data.join(format!("state/scheduler/{job}.json"))
            )?),
            butler_platform::secure_fs::OWNER_ONLY.then_some(true),
            "{job} privacy"
        );
    }
    let reply =
        s.gw.post(
            "/sessions",
            json!({"kind":"chat","title":"Another garden chat"}),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let chat = reply.data()["session"]["id"].as_str().unwrap();
    let (later_turn_id, turn) = s.turn(chat, "What flower do I prefer?").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    until(|| cache_complete(&graph, &later_turn_id)).await;
    until(|| readonly(&graph).query_row("SELECT COUNT(*) FROM memory_projection_jobs WHERE json_extract(hot_cache_state,'$.state')='pending'", [], |row| row.get::<_, i64>(0)).unwrap() == 0).await;
    let after = std::fs::read(&cache)?;
    let later_documents = hot_documents(&s.sandbox.data);
    let db = readonly(&graph);
    let pending: i64 = db.query_row("SELECT COUNT(*) FROM memory_projection_jobs WHERE json_extract(hot_cache_state,'$.state')='pending'", [], |row| row.get(0)).unwrap();
    eprintln!(
        "MEM-HOT-ACTIVE cache_changed={} cache_bytes={} hot_documents_before={} hot_documents_after={} pending_cache_jobs={pending} daily_sync={} daily_cycle={}",
        before != after,
        after.len(),
        first_documents.len(),
        later_documents.len(),
        sync["status"],
        cycle["status"]
    );
    drop(db);
    let documents = hot_cache_of(&s.sandbox.data, &later_turn_id);
    assert_eq!(documents.len(), 1);
    let newest = &documents[0];
    let mut remaining = newest.as_str();
    for expected in [
        "What Butler knows about the user",
        &answer,
        "What the user said in recent chats",
        FACT,
    ] {
        remaining = remaining
            .split_once(expected)
            .expect("hot-cache parts in order")
            .1;
    }
    assert!(!newest.contains("[model_interpretation/"));
    let recent = newest
        .split_once("What the user said in recent chats")
        .unwrap()
        .1;
    assert!(
        recent.contains(kept.trim()),
        "whole statements within the cap"
    );
    assert!(
        !recent.contains("Beta note."),
        "entry stops at the 1 KiB cap"
    );
    assert_eq!(pending, 0, "all pending cache jobs must drain");
    assert!(
        before != after
            && later_documents
                .iter()
                .any(|text| text.contains("blue iris")),
        "completed new memory never reached the active cache or another chat's hot-cache document"
    );
    let db = sqlite::open(&graph).unwrap();
    db.execute(
        "UPDATE memory_chunks SET status='superseded' WHERE source_key=?1",
        [format!("conversation_turn:{turn_id}")],
    )
    .unwrap();
    db.close().unwrap();
    let reply =
        s.gw.post(
            "/sessions",
            json!({"kind":"chat","title":"After source removal"}),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let chat = reply.data()["session"]["id"].as_str().unwrap();
    let (last_turn_id, turn) = s.turn(chat, "What do you remember?").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let documents = hot_cache_of(&s.sandbox.data, &last_turn_id);
    assert!(
        documents
            .iter()
            .all(|text| !text.contains("What Butler knows about the user"))
    );
    s.finish().await?;
    Ok(())
}

// Include every relative path (also empty directories), bytes and timestamps so
// additions, deletions and same-content replacements all fail the comparison.
type BoxSnapshot = Vec<(std::path::PathBuf, Vec<u8>, std::time::SystemTime)>;

fn box_snapshot(root: &Path) -> std::io::Result<BoxSnapshot> {
    fn visit(root: &Path, path: &Path, entries: &mut BoxSnapshot) -> std::io::Result<()> {
        let metadata = std::fs::metadata(path)?;
        let bytes = if metadata.is_file() {
            std::fs::read(path)?
        } else {
            Vec::new()
        };
        entries.push((
            path.strip_prefix(root).unwrap().to_owned(),
            bytes,
            metadata.modified()?,
        ));
        if metadata.is_dir() {
            for entry in std::fs::read_dir(path)? {
                visit(root, &entry?.path(), entries)?;
            }
        }
        Ok(())
    }
    let mut entries = Vec::new();
    visit(root, root, &mut entries)?;
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(entries)
}
