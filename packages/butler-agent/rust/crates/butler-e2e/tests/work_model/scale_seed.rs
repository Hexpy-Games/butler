use butler_e2e::e2e::scenario::Scenario;
use butler_platform::sqlite;
use rusqlite::params;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::Path;
#[path = "../app_storage_scale/seed.rs"]
mod app_seed;
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn stable(kind: &str, scope: &str, key: &str) -> String {
    format!(
        "{kind}-{}",
        &hash(&serde_json::to_vec(&(scope, key)).unwrap())[..24]
    )
}

pub(super) fn owner_scale(s: &Scenario, plan: &str) -> Result<(), Box<dyn std::error::Error>> {
    let db = sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let scope: String = db.query_row("SELECT scope_id FROM wm_plans WHERE id=?1", [plan], |r| {
        r.get(0)
    })?;
    let instruction: String = db.query_row(
        "SELECT instruction_id FROM wm_plans WHERE id=?1",
        [plan],
        |r| r.get(0),
    )?;
    let ledger =
        s.sandbox
            .data
            .join("project-ledger/projects")
            .join(stable("wm-session", &scope, "ledger"));
    db.execute_batch("BEGIN")?;
    seed_specs(&db, &ledger, &scope, &instruction, plan)?;
    for i in 0..9 {
        let suffix = format!("-retained-{i}");
        let id = format!("{plan}{suffix}");
        db.execute("INSERT INTO wm_plans(scope_id,id,owner_session_id,instruction_id,root_node_id,root_revision,tier,objective,graph_revision,tree_version,status,spec_count,task_count,edge_count,event_seq,phase) SELECT scope_id,?2,owner_session_id,instruction_id,root_node_id,root_revision,tier,objective,graph_revision,tree_version,status,spec_count,task_count,edge_count,event_seq,phase FROM wm_plans WHERE id=?1",params![plan,id])?;
        db.execute("INSERT INTO wm_tree(scope_id,plan_id,node_id,node_revision,parent_id,concern_id,lifecycle) SELECT scope_id,?2,node_id,node_revision,parent_id,concern_id,lifecycle FROM wm_tree WHERE plan_id=?1",params![plan,id])?;
        db.execute("INSERT INTO wm_works(scope_id,plan_id,id,node_id,node_revision,rank,outcome,status,binding_json) SELECT scope_id,?2,id||?3,node_id,node_revision,rank,outcome,status,binding_json FROM wm_works WHERE plan_id=?1",params![plan,id,suffix])?;
        db.execute("INSERT INTO wm_tasks SELECT scope_id,?2,work_id||?3,id||?3,node_id,node_revision,rank,'completed',5,json_set(card_json,'$.id',id||?3,'$.work_id',work_id||?3,'$.status','completed','$.revision',5,'$.result_revision',1,'$.review_id','REVIEW-retained-'||id||?3,'$.result_refs',json_array('artifact:retained'),'$.evidence_refs',json_array('test:retained')) FROM wm_tasks WHERE plan_id=?1",params![plan,id,suffix])?;
        db.execute("INSERT INTO wm_edges SELECT scope_id,?2,predecessor||?3,successor||?3,operation_key FROM wm_edges WHERE plan_id=?1",params![plan,id,suffix])?;
        db.execute("INSERT INTO wm_task_criteria SELECT scope_id,?2,task_id||?3,node_id,node_revision,criterion_id FROM wm_task_criteria WHERE plan_id=?1",params![plan,id,suffix])?;
        if i == 0 {
            db.execute("UPDATE wm_tasks SET status='pending',revision=1,card_json=json_set(card_json,'$.status','pending','$.revision',1,'$.result_revision',0,'$.review_id',NULL,'$.result_refs',json_array(),'$.evidence_refs',json_array()) WHERE plan_id=?1 AND rank<32",[&id])?;
            // These are independent active assignments, not successors started ahead of prerequisites.
            db.execute("DELETE FROM wm_edges WHERE plan_id=?1 AND (predecessor IN(SELECT id FROM wm_tasks WHERE plan_id=?1 AND rank<32) OR successor IN(SELECT id FROM wm_tasks WHERE plan_id=?1 AND rank<32))",[&id])?;
            db.execute("UPDATE wm_plans SET edge_count=(SELECT count(*) FROM wm_edges WHERE plan_id=?1) WHERE id=?1",[&id])?;
        }
        db.execute("INSERT INTO wm_results SELECT scope_id,plan_id,id,1,card_json FROM wm_tasks WHERE plan_id=?1 AND status='completed'",[&id])?;
        db.execute("INSERT INTO wm_reviews SELECT scope_id,plan_id,'REVIEW-retained-'||id,id,4,1,?2,1,json_object('spec_ref',json_extract(card_json,'$.spec_ref'),'criterion_results',json_array(json_object('criterion_id','AC','verdict','pass','reason','Retained verified fixture','evidence_refs',json_array('test:retained')))) FROM wm_tasks WHERE plan_id=?1 AND status='completed'",params![id,scope])?;
        db.execute(
            "INSERT INTO wm_counts SELECT scope_id,?2,'completed',total FROM wm_counts WHERE plan_id=?1",
            params![plan, id],
        )?;
    }
    seed_active_sessions(&db, &format!("{plan}-retained-0"), &scope, &instruction)?;
    db.execute_batch("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)")?;
    assert_eq!(
        db.query_row("SELECT count(*) FROM wm_tasks", [], |r| r.get::<_, i64>(0))?,
        100_000
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM wm_specs", [], |r| r.get::<_, i64>(0))?,
        10_000
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM wm_criteria", [], |r| r
            .get::<_, i64>(0))?,
        50_000
    );
    let app = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    app_seed::seed_owner_scale(&app, 3_000);
    app.execute_batch("WITH RECURSIVE n(i) AS (SELECT 500 UNION ALL SELECT i+1 FROM n WHERE i<599) INSERT INTO chats(id,title,kind,pinned,archived,created_at,updated_at) SELECT 'perf-c'||i,'Retained chat','chat',0,0,'2026-01-01','2026-01-01' FROM n;
    WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<100000) INSERT INTO events(type,turn_id,payload_json,created_at) SELECT 'work_model.retained','',json_object('text',hex(zeroblob(300))),'2026-01-01' FROM n;
    PRAGMA wal_checkpoint(TRUNCATE)")?;
    assert!(app.query_row("SELECT count(*) FROM events", [], |r| r.get::<_, i64>(0))? > 300_000);
    seed_retained(&db, &s.sandbox.data)?;
    eprintln!(
        "WM-13 fixture App={} BTCC={} bytes",
        std::fs::metadata(s.sandbox.data.join("app-server/butler-client.sqlite"))?.len(),
        std::fs::metadata(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?.len()
    );
    Ok(())
}

fn seed_active_sessions(
    db: &rusqlite::Connection,
    plan: &str,
    scope: &str,
    instruction: &str,
) -> rusqlite::Result<()> {
    let mut statement =
        db.prepare("SELECT id,card_json FROM wm_tasks WHERE plan_id=?1 ORDER BY rank,id LIMIT 32")?;
    let rows = statement
        .query_map([plan], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    assert_eq!(rows.len(), 32);
    for (i, (id, raw)) in rows.into_iter().enumerate() {
        let session = format!("{}scale-{i}", if i < 8 { "worker-" } else { "session-" });
        let mut card: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(card["status"], "pending");
        card["status"] = json!("running");
        card["revision"] = json!(2);
        card["assignee_session_id"] = json!(session);
        // Current attempt has no submitted result/review; other Tasks retain completed history.
        card["result_revision"] = json!(0);
        card["review_id"] = serde_json::Value::Null;
        card["result_refs"] = json!([]);
        card["evidence_refs"] = json!([]);
        db.execute("UPDATE wm_tasks SET status='running',revision=2,card_json=?2 WHERE plan_id=?1 AND id=?3",params![plan,card.to_string(),id])?;
        db.execute("INSERT INTO wm_sessions(session_id,scope_id,plan_id,current_task_id,routing_reason) VALUES(?1,?2,?3,?4,'owner_scale_active_fixture')",params![session,scope,plan,id])?;
        db.execute(
            "INSERT INTO wm_attempts VALUES(?1,?2,?3,?4,1,?5,?6,?7,'running')",
            params![
                scope,
                plan,
                format!("ATTEMPT-scale-{i}"),
                id,
                session,
                instruction,
                card["spec_ref"].to_string()
            ],
        )?;
    }
    db.execute(
        "UPDATE wm_counts SET total=total-32 WHERE plan_id=?1 AND status='completed'",
        [plan],
    )?;
    db.execute(
        "INSERT INTO wm_counts VALUES(?1,?2,'running',32)",
        params![scope, plan],
    )?;
    db.execute("UPDATE wm_plans SET status='running' WHERE id=?1", [plan])?;
    db.execute(
        "UPDATE wm_works SET status='running' WHERE plan_id=?1",
        [plan],
    )?;
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM wm_attempts WHERE status='running'",
            [],
            |r| r.get::<_, i64>(0)
        )?,
        32
    );
    Ok(())
}
fn seed_specs(
    db: &rusqlite::Connection,
    ledger: &Path,
    scope: &str,
    instruction: &str,
    plan: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    for i in 3..10_000 {
        let node = format!("scale-{i}");
        let parent = if i == 3 {
            "buildable".to_owned()
        } else if i <= 7 {
            format!("scale-{}", i - 1)
        } else {
            "goal".to_owned()
        };
        let criteria=(0..5).map(|c|json!({"id":format!("AC-{c}"),"part_id":"API","text":"Complete criterion","verification":"E2E exact count"})).collect::<Vec<_>>();
        let draft = json!({"node_id":node,"node_revision":1,"parent_id":parent,"concern_id":node,"responsibility":"Owned fixture requirement","kind":"software","parts":[{"id":"API","behaviour":"Exact response","design":"Indexed typed state","implementation":"Read selected immutable revision"}],"criteria":criteria,"child_coverage":[],"source_refs":[instruction],"decision_refs":[],"research_method":null,"independent_review":false});
        let body=json!({"schema":"butler.work-model.spec.v1","scope_id":scope,"authoring_instruction_id":instruction,"node":draft}).to_string();
        let id = format!("{}-R1", stable("SPEC-WM", scope, &node));
        let digest = hash(body.as_bytes());
        let reference =
            json!({"node_id":node,"node_revision":1,"ledger_revision_id":id,"content_hash":digest});
        let mut file = std::fs::File::create(
            ledger
                .join("specs")
                .join(format!("{}.md", id.to_lowercase())),
        )?;
        file.write_all(
            format!("---\nid: {id}\nkind: spec\nstatus: published\n---\n{body}\n").as_bytes(),
        )?;
        file.sync_all()?;
        db.execute(
            "INSERT INTO wm_specs VALUES(?1,?2,1,?3,?4,?5,?6,?2,0)",
            params![scope, node, id, digest, reference.to_string(), parent],
        )?;
        db.execute("INSERT INTO wm_tree(scope_id,plan_id,node_id,node_revision,parent_id,concern_id) VALUES(?1,?2,?3,1,?4,?3)",params![scope,plan,node,parent])?;
        db.execute(
            "INSERT INTO wm_parts VALUES(?1,?2,1,'API')",
            params![scope, node],
        )?;
        for c in 0..5 {
            db.execute(
                "INSERT INTO wm_criteria VALUES(?1,?2,1,?3,'API')",
                params![scope, node, format!("AC-{c}")],
            )?;
        }
    }
    butler_platform::secure_fs::sync_directory(&ledger.join("specs")).unwrap_or(Ok(()))?;
    db.execute("UPDATE wm_plans SET spec_count=10000 WHERE id=?1", [plan])?;
    Ok(())
}
pub(super) fn checkpoint(s: &Scenario) {
    for path in [
        "agent-runtime/btcc.sqlite",
        "app-server/butler-client.sqlite",
    ] {
        sqlite::open(s.sandbox.data.join(path))
            .unwrap()
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
    }
}

fn seed_retained(db: &rusqlite::Connection, data: &Path) -> Result<(), Box<dyn std::error::Error>> {
    use std::io::{BufWriter, Write};
    // Retained tool output is a content-addressed record, never copied to audit.
    let body = json!({"schema":"butler.owner-scale.fixture.v1","output":"x".repeat(1_750_000)})
        .to_string();
    let digest = hash(body.as_bytes());
    db.execute_batch("BEGIN")?;
    let mut record = db.prepare("INSERT INTO btcc_records VALUES(?1,'tool_result',?2,?3)")?;
    for i in 0..4000 {
        record.execute(params![format!("retained-tool-{i}"), digest, body])?;
    }
    drop(record);
    db.execute_batch("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)")?;
    let root = data.join("transcripts");
    std::fs::create_dir_all(&root)?;
    let line = format!("{}\n", json!({"role":"tool","content":"x".repeat(1024)}));
    for i in 0..2440 {
        let count = if i == 0 { 290_000 } else { 470 };
        let mut file = BufWriter::new(std::fs::File::create(
            root.join(format!("retained-{i}.jsonl")),
        )?);
        for _ in 0..count {
            file.write_all(line.as_bytes())?;
        }
        file.flush()?;
        file.get_ref().sync_all()?;
    }
    butler_platform::secure_fs::sync_directory(&root).unwrap_or(Ok(()))?;
    let root = data.join("metrics");
    std::fs::create_dir_all(&root)?;
    let mut file = BufWriter::new(std::fs::File::create(
        root.join("operational-events.jsonl"),
    )?);
    let line = format!(
        "{}\n",
        json!({"schema":"butler.operational-event.v1","ts":chrono::Utc::now().timestamp_millis(),"category":"maintenance","name":"synthetic","status":"ok","rawTextStored":false,"padding":"x".repeat(1024)})
    );
    for _ in 0..300_000 {
        file.write_all(line.as_bytes())?;
    }
    file.flush()?;
    file.get_ref().sync_all()?;
    butler_platform::secure_fs::sync_directory(&root).unwrap_or(Ok(()))?;
    Ok(())
}
pub(super) fn managed_files(
    s: &Scenario,
) -> Result<
    std::collections::BTreeMap<std::path::PathBuf, (u64, std::time::SystemTime)>,
    std::io::Error,
> {
    let mut paths = vec![s.sandbox.data.join("project-ledger")];
    for base in [
        "agent-runtime/btcc.sqlite",
        "app-server/butler-client.sqlite",
    ] {
        for suffix in ["", "-wal"] {
            let path = s.sandbox.data.join(format!("{base}{suffix}"));
            if path.exists() {
                paths.push(path);
            }
        }
    }
    let mut files = std::collections::BTreeMap::new();
    while let Some(path) = paths.pop() {
        if path.is_dir() {
            for entry in std::fs::read_dir(path)? {
                paths.push(entry?.path());
            }
        } else {
            let metadata = std::fs::metadata(&path)?;
            files.insert(path, (metadata.len(), metadata.modified()?));
        }
    }
    Ok(files)
}

pub(super) fn ledger_bytes(s: &Scenario) -> std::io::Result<u64> {
    Ok(managed_files(s)?
        .into_iter()
        .filter(|(path, _)| path.starts_with(s.sandbox.data.join("project-ledger")))
        .map(|(_, (bytes, _))| bytes)
        .sum())
}
