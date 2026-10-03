//! Reset through authenticated App routes, actual ingestion and daily catch-up.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
use super::memory_reset_support as support;
use butler_e2e::e2e::HarnessError;
use butler_platform::sqlite;
use rusqlite::OpenFlags;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

fn graph(root: &Path) -> PathBuf {
    let memory = root.join("cognition/memory");
    let active: Value =
        serde_json::from_slice(&std::fs::read(memory.join("active-generation.json")).unwrap())
            .unwrap();
    memory
        .join("generations")
        .join(active["generation_id"].as_str().unwrap())
        .join("graph.sqlite")
}
fn count(path: &Path, sql: &str) -> i64 {
    sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .unwrap()
        .query_row(sql, [], |row| row.get(0))
        .unwrap()
}

#[tokio::test]
async fn chat_reset_preserves_profile_instructions_and_chats_then_remembers_future_turns()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (base, server) = support::profile_server().await?;
    let mut scenario = support::setup("MEM-CHAT-RESET").await?;
    support::local_model(&scenario, &base).await?;
    assert_eq!(
        scenario
            .gw
            .patch("/personalization", json!({"profiling":{"mode":"basic"}}))
            .await?
            .status,
        200
    );
    let rules = scenario.sandbox.data.join("cognition/memory/rules");
    std::fs::create_dir_all(&rules)?;
    std::fs::write(rules.join("kept.md"), "Keep concise explanations.")?;
    std::fs::write(
        rules.join("INDEX.md"),
        "- [Keep concise explanations.](kept.md)\n",
    )?;
    let instructions = scenario
        .gw
        .get("/memory/instructions")
        .await?
        .data()
        .clone();
    let (_, turn) = scenario
        .turn("general", "I prefer concise answers.")
        .await?;
    assert_eq!(turn["state"], "delivered");
    support::cycle(&mut scenario).await?;
    let old_graph = graph(&scenario.sandbox.data);
    assert!(
        count(
            &old_graph,
            "SELECT COUNT(*) FROM memory_chunks WHERE origin_kind IN ('user_input','assistant_public')"
        ) > 0
    );
    let profile = scenario
        .sandbox
        .data
        .join("cognition/profile/profile.sqlite");
    let profile_before = count(&profile, "SELECT COUNT(*) FROM stable_profile_entries");
    assert!(profile_before > 0);
    let chats = scenario
        .sandbox
        .data
        .join("runtime/conversation-store.sqlite");
    let chats_before = count(&chats, "SELECT COUNT(*) FROM conversation_messages");
    seed_typed_projection(&old_graph);
    let typed_before = typed_projection(&old_graph);
    let aliases_before = typed_aliases(&old_graph);
    let inventory = scenario
        .gw
        .post("/memory/inventory/check", json!({}))
        .await?;
    let id = uuid::Uuid::new_v4().to_string();
    let input = json!({"operation_id":id,"inventory_revision":inventory.data()["revision"]});
    let unauthenticated = scenario
        .gw
        .http()
        .post(format!("{}/memory/reset/chat-memory", scenario.gw.base))
        .json(&input)
        .send()
        .await?;
    assert_eq!(unauthenticated.status().as_u16(), 401);
    let accepted = scenario
        .gw
        .post("/memory/reset/chat-memory", input.clone())
        .await?;
    assert_eq!(accepted.status, 202, "{}", accepted.text);
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let receipt = scenario.gw.get(&format!("/memory/reset/{id}")).await?;
            assert_ne!(receipt.data()["phase"], "failed", "{}", receipt.text);
            if receipt.data()["phase"] == "complete" && receipt.data()["removal_pending"] == false {
                return Ok::<(), HarnessError>(());
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("reset completion")?;
    assert_ne!(graph(&scenario.sandbox.data), old_graph);
    scenario.restart().await?;
    let measured = scenario
        .gw
        .post("/memory/inventory/check", json!({}))
        .await?;
    assert_eq!(measured.status, 200, "{}", measured.text);
    assert_eq!(measured.data()["kinds"][1]["item_count"], 0);
    assert_eq!(measured.data()["kinds"][0]["item_count"], 1);
    assert_eq!(measured.data()["kinds"][2]["item_count"], profile_before);
    assert_eq!(
        count(
            &graph(&scenario.sandbox.data),
            "SELECT COUNT(*) FROM memory_chunk_sources WHERE source_kind='conversation'"
        ),
        0
    );
    assert_eq!(
        typed_projection(&graph(&scenario.sandbox.data)),
        typed_before
    );
    assert_eq!(
        typed_aliases(&graph(&scenario.sandbox.data)),
        aliases_before
    );
    assert_eq!(
        count(
            &graph(&scenario.sandbox.data),
            "SELECT COUNT(*) FROM memory_nodes WHERE id='conversation-only'"
        ),
        0
    );
    assert_eq!(
        count(&profile, "SELECT COUNT(*) FROM stable_profile_entries"),
        profile_before
    );
    assert_eq!(
        count(&chats, "SELECT COUNT(*) FROM conversation_messages"),
        chats_before
    );
    assert_eq!(
        scenario.gw.get("/memory/instructions").await?.data(),
        &instructions
    );
    support::cycle(&mut scenario).await?;
    assert_eq!(
        count(
            &graph(&scenario.sandbox.data),
            "SELECT COUNT(*) FROM memory_chunk_sources WHERE source_kind='conversation'"
        ),
        0
    );
    let (_, turn) = scenario
        .turn("general", "I prefer concise answers for new chats too.")
        .await?;
    assert_eq!(turn["state"], "delivered");
    support::cycle(&mut scenario).await?;
    assert!(
        count(
            &graph(&scenario.sandbox.data),
            "SELECT COUNT(*) FROM memory_chunk_sources WHERE source_kind='conversation'"
        ) > 0
    );
    let repeated = scenario.gw.post("/memory/reset/chat-memory", input).await?;
    assert_eq!(repeated.data()["phase"], "complete");
    assert!(
        count(
            &graph(&scenario.sandbox.data),
            "SELECT COUNT(*) FROM memory_chunk_sources WHERE source_kind='conversation'"
        ) > 0
    );
    scenario.finish().await?;
    server.abort();
    Ok(())
}

async fn wait_reset(
    s: &butler_e2e::e2e::scenario::Scenario,
    id: &str,
) -> Result<Value, HarnessError> {
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let reply = s.gw.get(&format!("/memory/reset/{id}")).await?;
            assert_ne!(reply.data()["phase"], "failed", "{}", reply.text);
            if reply.data()["phase"] == "complete" {
                return Ok(reply.data().clone());
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("reset completion")
}

#[tokio::test]
async fn project_reset_is_scoped_and_summary_stays_empty_until_a_new_project_conversation()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (base, server) = support::profile_server().await?;
    let mut s = support::setup("MEM-PROJECT-RESET").await?;
    support::local_model(&s, &base).await?;
    let mut projects = Vec::new();
    let mut chats = Vec::new();
    for name in ["Selected project", "Other project"] {
        let created =
            s.gw.post(
                "/projects",
                json!({"source":"scratch", "display_name":name}),
            )
            .await?;
        assert_eq!(created.status, 201, "{}", created.text);
        let project = created.data()["project"]["id"].as_str().unwrap().to_owned();
        let created =
            s.gw.post(
                "/sessions",
                json!({"kind":"project", "title":name, "project_id":project}),
            )
            .await?;
        assert_eq!(created.status, 201, "{}", created.text);
        let chat = created.data()["session"]["id"].as_str().unwrap().to_owned();
        let (_, turn) = s
            .turn(&chat, "Remember this project's conversation preference.")
            .await?;
        assert_eq!(turn["state"], "delivered");
        projects.push(project);
        chats.push(chat);
    }
    assert_eq!(
        s.turn("general", "Remember this general conversation.")
            .await?
            .1["state"],
        "delivered"
    );
    support::cycle(&mut s).await?;
    let memory = s.sandbox.data.join("cognition/memory");
    let rules = memory.join("rules");
    std::fs::create_dir_all(&rules)?;
    use sha2::{Digest, Sha256};
    for (index, project) in projects.iter().enumerate() {
        let text = format!("Keep instruction for project {index}.");
        let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
        let record = format!("project{index}");
        std::fs::write(rules.join(format!("{record}.md")), &text)?;
        std::fs::write(rules.join(format!("{record}.source.json")), json!({"schema":"butler.explicit-rule-binding.v1", "state":"active", "record_id":record, "revision":hash, "operation_id":record, "content_hash":hash, "project_id":project, "conversation_session_id":null, "conversation_message_id":null, "observed_at":"2026-10-03T00:00:00.000Z", "operations":[]}).to_string())?;
        let capsule = memory.join("projects").join(format!("{project}.md"));
        std::fs::create_dir_all(capsule.parent().unwrap())?;
        std::fs::write(capsule, format!("Old summary for {index}"))?;
    }
    std::fs::write(
        rules.join("INDEX.md"),
        "- [Selected](project0.md)\n- [Other](project1.md)\n",
    )?;
    let before = s.gw.get("/memory/instructions").await?.data().clone();
    assert_eq!(before["instructions"].as_array().unwrap().len(), 2);
    let selected_sql = format!(
        "SELECT COUNT(*) FROM memory_chunks WHERE project_id='{}'",
        projects[0]
    );
    let other_sql = format!(
        "SELECT COUNT(*) FROM memory_chunks WHERE project_id='{}'",
        projects[1]
    );
    let general_sql = "SELECT COUNT(*) FROM memory_chunks WHERE project_id IS NULL";
    let old = graph(&s.sandbox.data);
    assert!(count(&old, &selected_sql) > 0);
    let selected_fts = selected_sql.replace("memory_chunks", "memory_episode_fts_meta");
    let other_fts = other_sql.replace("memory_chunks", "memory_episode_fts_meta");
    assert!(count(&old, &selected_fts) > 0);
    let other_fts_count = count(&old, &other_fts);
    assert!(other_fts_count > 0);
    let other_count = count(&old, &other_sql);
    let general_count = count(&old, general_sql);
    let canonical = s.sandbox.data.join("runtime/conversation-store.sqlite");
    let chat_count = count(&canonical, "SELECT COUNT(*) FROM conversation_messages");
    let checked = s.gw.post("/memory/inventory/check", json!({})).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let input = json!({"operation_id":id, "inventory_revision":checked.data()["revision"]});
    let route = format!("/memory/reset/projects/{}", projects[0]);
    let accepted = s.gw.post(&route, input.clone()).await?;
    assert_eq!(accepted.status, 202, "{}", accepted.text);
    wait_reset(&s, &id).await?;
    let active = graph(&s.sandbox.data);
    assert_eq!(count(&active, &selected_sql), 0);
    assert_eq!(count(&active, &selected_fts), 0);
    assert_eq!(count(&active, &other_fts), other_fts_count);
    assert_eq!(count(&active, &other_sql), other_count);
    assert_eq!(count(&active, general_sql), general_count);
    assert_eq!(
        count(&canonical, "SELECT COUNT(*) FROM conversation_messages"),
        chat_count
    );
    let remaining = s.gw.get("/memory/instructions").await?.data().clone();
    assert_eq!(remaining["instructions"].as_array().unwrap().len(), 1);
    assert_eq!(remaining["instructions"][0]["project_id"], projects[1]);
    let selected_summary = memory.join("projects").join(format!("{}.md", projects[0]));
    assert!(!selected_summary.exists());
    assert_eq!(
        std::fs::read_to_string(memory.join("projects").join(format!("{}.md", projects[1])))?,
        "Old summary for 1"
    );
    support::cycle(&mut s).await?;
    assert!(
        !selected_summary.exists(),
        "daily cycle rebuilt a reset summary"
    );
    assert_eq!(count(&graph(&s.sandbox.data), &selected_sql), 0);
    assert_eq!(
        s.turn(&chats[0], "Remember only this new project conversation.")
            .await?
            .1["state"],
        "delivered"
    );
    support::cycle(&mut s).await?;
    assert!(count(&graph(&s.sandbox.data), &selected_sql) > 0);
    assert_eq!(s.gw.post(&route, input).await?.data()["phase"], "complete");
    assert!(count(&graph(&s.sandbox.data), &selected_sql) > 0);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn reset_recovers_after_kill_while_snapshot_is_blocked() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (base, server) = support::profile_server().await?;
    let mut s = support::setup("MEM-RESET-CRASH").await?;
    support::local_model(&s, &base).await?;
    assert_eq!(
        s.turn("general", "Remember this pre-reset chat.").await?.1["state"],
        "delivered"
    );
    support::cycle(&mut s).await?;
    let checked = s.gw.post("/memory/inventory/check", json!({})).await?;
    let old = graph(&s.sandbox.data);
    let blocker = sqlite::open(&old).unwrap();
    blocker.execute_batch("BEGIN EXCLUSIVE").unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let accepted =
        s.gw.post(
            "/memory/reset/chat-memory",
            json!({"operation_id":id,"inventory_revision":checked.data()["revision"]}),
        )
        .await?;
    assert_eq!(accepted.status, 202, "{}", accepted.text);
    assert_eq!(
        s.gw.get(&format!("/memory/reset/{id}")).await?.data()["phase"],
        "preparing"
    );
    s.agent.kill9()?;
    blocker.execute_batch("ROLLBACK").unwrap();
    drop(blocker);
    s.gw = s.agent.start_again().await?;
    wait_reset(&s, &id).await?;
    assert_ne!(graph(&s.sandbox.data), old);
    assert_eq!(
        count(
            &graph(&s.sandbox.data),
            "SELECT COUNT(*) FROM memory_chunk_sources WHERE source_kind='conversation'"
        ),
        0
    );
    support::cycle(&mut s).await?;
    assert_eq!(
        count(
            &graph(&s.sandbox.data),
            "SELECT COUNT(*) FROM memory_chunk_sources WHERE source_kind='conversation'"
        ),
        0
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

fn typed_projection(path: &Path) -> String {
    let db = sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    db.query_row("SELECT json_group_array(json_array(c.memory_chunk_id,c.current_revision,c.summary,s.source_id,s.source_kind,s.content_hash,n.id,n.label_original,a.surface_original) ORDER BY s.source_id,n.id) FROM memory_chunks c JOIN memory_chunk_sources s ON s.episode_id=c.memory_chunk_id JOIN memory_evidence e ON e.source_id=s.source_id JOIN memory_nodes n ON n.id=e.node_id JOIN memory_aliases a ON a.node_id=n.id AND a.source_id=s.source_id WHERE c.memory_chunk_id IN ('typed-fixture','task-fixture')", [], |row| row.get(0)).unwrap()
}

fn typed_aliases(path: &Path) -> String {
    let db = sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    db.query_row("SELECT json_group_array(json_array(n.id,n.label_original,a.surface_original,a.source_id) ORDER BY n.id,a.source_id) FROM memory_aliases a JOIN memory_nodes n ON n.id=a.node_id WHERE a.source_id IN ('typed-source','task-source')", [], |row| row.get(0)).unwrap()
}

fn seed_typed_projection(path: &Path) {
    let db = sqlite::open(path).unwrap();
    db.execute_batch(r"
BEGIN;
INSERT INTO memory_chunks(memory_chunk_id,source_key,current_revision,origin_kind,status,summary,summary_status,source_hash,created_at,updated_at) VALUES('typed-fixture','explicit_record:typed-fixture','typed-revision','explicit','active','Complete typed instruction projection','complete','typed-hash','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z');
INSERT INTO memory_chunk_sources(source_id,episode_id,revision,source_kind,part_id,scalar_pointer,byte_start,byte_end,content_hash,role,origin_kind,observed_at,basis) VALUES('typed-source','typed-fixture','typed-revision','explicit_record','typed-fixture','/text',0,5,'typed-hash','user','explicit','2026-10-01T00:00:00Z','literal');
INSERT INTO memory_nodes(id,type,label_original,identity_scope,created_at) VALUES('typed-node','entity','Typed supported entity','global','2026-10-01T00:00:00Z'),('conversation-only','entity','Conversation-only entity','global','2026-10-01T00:00:00Z');
INSERT INTO memory_nodes(id,type,label_original,identity_scope,created_at) VALUES('typed-alias-only','entity','Typed alias-only entity','global','2026-10-01T00:00:00Z');
INSERT INTO memory_aliases VALUES('typed-alias-only','Alias-only typed support','alias-only typed support','alias-only typed support','[]','typed-source','literal');
INSERT INTO memory_evidence VALUES('typed-node','typed-source','typed-fixture','typed-revision');
INSERT INTO memory_evidence SELECT 'typed-node',source_id,episode_id,revision FROM memory_chunk_sources WHERE source_kind='conversation';
INSERT INTO memory_evidence SELECT 'conversation-only',source_id,episode_id,revision FROM memory_chunk_sources WHERE source_kind='conversation';
INSERT INTO memory_aliases VALUES('typed-node','Typed supported alias','typed supported alias','typed supported alias','[]','typed-source','literal');
INSERT INTO memory_aliases SELECT 'typed-node','Old conversation alias','old conversation alias','old conversation alias','[]',source_id,'literal' FROM memory_chunk_sources WHERE source_kind='conversation';
INSERT INTO memory_source_text(source_id,text,text_hash) VALUES('typed-source','Typed supported text','typed-hash');
INSERT INTO memory_source_terms SELECT 'typed',id FROM memory_source_text WHERE source_id='typed-source';
INSERT INTO memory_chunks SELECT 'task-fixture','task_report:task-fixture',current_revision,NULL,NULL,NULL,NULL,NULL,'task_report',status,summary,summary_status,source_hash,created_at,updated_at FROM memory_chunks WHERE memory_chunk_id='typed-fixture';
INSERT INTO memory_chunk_sources SELECT 'task-source','task-fixture',revision,'task_report',NULL,NULL,'task-fixture',scalar_pointer,byte_start,byte_end,content_hash,'assistant','task_report',observed_at,basis FROM memory_chunk_sources WHERE source_id='typed-source';
INSERT INTO memory_evidence VALUES('typed-node','task-source','task-fixture','typed-revision');
INSERT INTO memory_aliases SELECT node_id,'Task supported alias','task supported alias','task supported alias',language_tags,'task-source',resolution_kind FROM memory_aliases WHERE source_id='typed-source';
INSERT INTO edges(edge_id,source_node_id,target_node_id,rel_type) VALUES('typed-edge','typed-node','typed-node','supports');
INSERT INTO edge_evidence VALUES('typed-edge','typed-source','literal','fixture');
COMMIT;
").unwrap();
}
