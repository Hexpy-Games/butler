//! Existing grant identities and large unrelated settled history, isolated from live data.
use butler_e2e::e2e::HarnessError;
use butler_platform::sqlite;
use rusqlite::{Connection, params, params_from_iter};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub(super) const COMMAND: &str = "bun run check --exact-target";
fn digest(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

pub(super) fn workspace(i: usize) -> &'static str {
    if i == 3001 {
        "/workspace/검토/\"quoted\"/back\\slash"
    } else {
        "/workspace"
    }
}
fn scope_key(i: usize) -> String {
    digest(&json!({"command":command(i), "cwd":workspace(i), "kind":"command"}))
}
pub(super) fn reference(i: usize) -> String {
    let owner = format!("butler/app-chat-{}", i % 600);
    format!(
        "permission-{}",
        &digest(&json!([owner, workspace(i), scope_key(i)]))[..32]
    )
}
pub(super) fn command(i: usize) -> String {
    if i < 2 {
        COMMAND.into()
    } else {
        format!("cargo test case_{i}")
    }
}
fn source(db: &Connection, i: usize) {
    let id = format!("request-{i}");
    let owner = format!("butler/app-chat-{}", i % 600);
    let date = format!("2026-10-05T00:{:02}:{:02}Z", i / 60 % 60, i % 60);
    let input = json!({"command":command(i),"cwd":workspace(i)});
    let row = json!({
        "request_id":id,"request_ref":id,"identity_sha256":id,"owner_session_id":owner,
        "source_session_id":owner,"source_turn_id":id,"source_work_id":id,"workspace_path":workspace(i),
        "plan_revision_id":id,"action_key":id,"authority_generation":1,"capability":"run_command",
        "normalized_target":command(i),"normalized_input_json":input.to_string(),"model_ref":"custom/stub",
        "reasoning_effort":"low","category":"command","reason":"Run one reviewed command","executable":"run_command",
        "command_count":1,"decision":"allowed","allow_scope":"conversation","schedule_client_message_id":id,
        "schedule_input_text":"","outcome":"applied","created_at":date,"updated_at":date
    });
    let fields = row.as_object().unwrap();
    let values: Vec<rusqlite::types::Value> = fields
        .values()
        .map(|v| {
            if let Some(number) = v.as_i64() {
                number.into()
            } else {
                v.as_str()
                    .expect("source fields are scalar")
                    .to_owned()
                    .into()
            }
        })
        .collect();
    db.execute(
        &format!(
            "INSERT INTO btcc_authority_requests ({}) VALUES ({})",
            fields.keys().cloned().collect::<Vec<_>>().join(","),
            vec!["?"; fields.len()].join(",")
        ),
        params_from_iter(values),
    )
    .unwrap();
    db.execute("INSERT INTO btcc_conversation_permissions VALUES(?1,?2,?3,?4,'Private title','Private description',?5,NULL)", params![reference(i),owner,workspace(i),scope_key(i),date]).unwrap();
}

pub(crate) fn history(db: &Connection, payload_bytes: usize) {
    // 10k unrelated settled requests: large payloads must never enter the list query.
    db.execute(&format!("WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<9999)
      INSERT INTO btcc_authority_requests(request_id,request_ref,identity_sha256,owner_session_id,source_session_id,source_turn_id,source_work_id,workspace_path,plan_revision_id,action_key,authority_generation,capability,normalized_target,normalized_input_json,model_ref,reasoning_effort,category,reason,executable,command_count,decision,allow_scope,schedule_client_message_id,schedule_input_text,outcome,created_at,updated_at)
      SELECT 'history-'||i,'history-'||i,'history-'||i,'unrelated','unrelated','history-'||i,'history-'||i,'/history','history','history-'||i,1,'run_command','history',json_object('padding',printf('%0{payload_bytes}d',i)),'custom/stub','low','command','history','run_command',1,'modified','once','history-'||i,'','applied','2000-01-01T00:00:00Z','2000-01-01T00:00:00Z' FROM n"), []).unwrap();
    let mut plan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM btcc_authority_requests WHERE owner_session_id='butler/app-chat-0' AND decision='allowed' AND allow_scope='conversation' ORDER BY created_at").unwrap();
    let details = plan
        .query_map([], |row| row.get::<_, String>(3))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(
        details
            .iter()
            .any(|s| s.contains("idx_btcc_authority_requests_owner_pending"))
    );
    assert!(
        details
            .iter()
            .all(|s| !s.contains("SCAN btcc_authority_requests"))
    );
}

pub(super) async fn seed(
    data: std::path::PathBuf,
    count: usize,
    scale: bool,
) -> Result<(), HarnessError> {
    tokio::task::spawn_blocking(move || {
        let mut db = sqlite::open(data.join("agent-runtime/btcc.sqlite")).unwrap();
        let tx = db.transaction().unwrap();
        for i in 0..count { source(&tx, i); }
        if scale { history(&tx, if std::env::var("BUTLER_E2E_PERF").as_deref() == Ok("1") { 700_000 } else { 1024 }); }
        else { source(&tx, 3001); tx.execute("INSERT INTO btcc_conversation_permissions VALUES('orphan','deleted','/workspace','orphan','Private','Private','2000-01-01T00:00:00Z',NULL)", []).unwrap(); }
        tx.commit().unwrap();
        let app = sqlite::open(data.join("app-server/butler-client.sqlite")).unwrap();
        app.execute_batch("WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<599) INSERT INTO chats(id,title,kind,created_at,updated_at) SELECT 'chat-'||i,'Chat '||i,'chat','2000-01-01T00:00:00Z','2000-01-01T00:00:00Z' FROM n").unwrap();
        eprintln!("approval fixture: grants={count} chats=600 btcc_bytes={}", std::fs::metadata(data.join("agent-runtime/btcc.sqlite")).unwrap().len());
    }).await.map_err(|e| HarnessError(e.to_string()))
}
