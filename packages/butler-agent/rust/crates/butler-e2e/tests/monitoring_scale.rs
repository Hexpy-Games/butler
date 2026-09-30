//! Owner-scale monitoring keeps complete, current output while chat views load.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Scenario, Setup},
};
use rusqlite::Connection;
use serde_json::Value;
#[path = "monitoring_scale/history.rs"]
mod history;
use history::assert_history_labels;
use std::time::Instant;

fn seed(s: &Scenario) {
    let db = Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite")).unwrap();
    db.execute_batch("BEGIN;
      WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<599)
      INSERT INTO chats(id,title,kind,created_at,updated_at)
      SELECT 'monitor-c'||i,'Chat '||i,'chat','2026-01-01','2026-01-01' FROM n;
      WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<4999)
      INSERT INTO turns(id,chat_id,state,safe_status_label,created_at,updated_at)
      SELECT 'monitor-t'||i,'monitor-c'||(i%600),'delivered','Delivered','2026-01-01','2026-01-01' FROM n;
      WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<299999)
      INSERT INTO events(type,turn_id,payload_json,created_at)
      SELECT 'agent.turn_event','monitor-t'||(i%5000),json_object('text',hex(zeroblob(200))),'2026-01-01' FROM n;
      WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<71999)
      INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at)
      SELECT 'monitor-m'||i,'monitor-c'||(i/3000),'assistant',
      CASE WHEN i%3000=2999 THEN 'Final report '||(i/3000) ELSE hex(zeroblob(1000)) END,
      'delivered','2026-01-01','2026-01-01' FROM n;
      COMMIT;").unwrap();
    let btcc = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    btcc.execute_batch("INSERT INTO btcc_inbound_inbox(inbox_id,session_id,trigger_key,turn_id,admission_input_hash,command_json,status)
        VALUES('monitor-inbox','monitor-session','monitor-trigger','turn','hash','{}','accepted');
      INSERT INTO btcc_turns(turn_id,session_id,inbox_id,trigger_key,original_message_id,original_message,
        admission_snapshot_ref,model_selection_json,context_json,semantic_state,revision,execution_fence)
        VALUES('turn','monitor-session','monitor-inbox','monitor-trigger','message','Work','snapshot','{}','{}','delivered',1,1);
      WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<49999)
      INSERT INTO btcc_guided_works(work_id,session_id,scope_kind,scope_ref,origin_turn_id,
        origin_message_id,objective,status,created_at,updated_at)
      SELECT 'monitor-w'||i,'butler/app-monitor-c'||(i%24),'session','scope','turn','message','Work',
        CASE WHEN i<24 THEN 'open' ELSE 'abandoned' END,'2026-01-01',printf('2026-01-01T%06d',i) FROM n;").unwrap();
}

fn assert_status(value: &Value) {
    let items = value["items"].as_array().unwrap();
    assert_eq!(items.len(), 8);
    assert_eq!(value["counts"]["attention"], 8);
    for (index, item) in items.iter().enumerate() {
        let number = 23 - index;
        assert_eq!(item["session_id"], format!("butler/app-monitor-c{number}"));
        assert_eq!(
            item["latest_report_summary"],
            format!("Final report {number}")
        );
        assert_eq!(item["effect_count"], 0);
        assert_eq!(item["state"], "attention");
        assert_eq!(item["completed_actions"], 0);
        assert_eq!(item["total_actions"], 0);
    }
}

#[tokio::test]
async fn monitoring_owner_scale_content_and_polling() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("MONITOR-PERF-01")?.start().await?;
    s.agent.terminate().await?;
    seed(&s);
    s.gw = s.agent.start_again().await?;
    s.agent.launch.set_env("BUTLER_MONITOR_LANE", "1");
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    let lane_log = s.sandbox.logs.join("agent-3.log");
    let log_before = std::fs::read_to_string(&lane_log)?.len();
    let mut status_samples = Vec::new();
    for _ in 0..10 {
        let start = Instant::now();
        let reply = s.gw.get("/work-status").await?;
        status_samples.push(start.elapsed());
        assert_eq!(reply.status, 200, "{}", reply.text);
        assert_status(reply.data());
    }
    let log_after = std::fs::read_to_string(&lane_log)?;
    let lane_ns: u64 = log_after[log_before..]
        .lines()
        .filter_map(|line| line.strip_prefix("MONITOR_LANE_NS "))
        .filter_map(|number| number.parse::<u64>().ok())
        .sum();
    if lane_ns > 0 {
        eprintln!(
            "MONITOR-PERF-01: App lane occupancy per solo poll {:?} (includes concurrent maintenance)",
            std::time::Duration::from_nanos(lane_ns) / 10
        );
    }
    let poll = s.gw.clone();
    let polling = tokio::spawn(async move {
        for _ in 0..20 {
            let reply = poll.get("/work-status").await?;
            assert_eq!(reply.status, 200, "{}", reply.text);
            assert_status(reply.data());
        }
        Ok::<_, HarnessError>(())
    });
    let mut views = Vec::new();
    for _ in 0..20 {
        let start = Instant::now();
        let reply = s.gw.get("/session-view?session_id=monitor-c23").await?;
        views.push(start.elapsed());
        assert_eq!(reply.status, 200, "{}", reply.text);
        let messages = reply.data()["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 200);
        assert_eq!(reply.data()["latest_turn"]["id"], "monitor-t4823");
        assert_eq!(reply.data()["latest_turn"]["state"], "delivered");
        for (index, message) in messages.iter().enumerate() {
            assert_eq!(message["id"], format!("monitor-m{}", 71800 + index));
            assert_eq!(message["role"], "assistant");
            assert_eq!(message["status"], "delivered");
            if index < 199 {
                assert_eq!(message["text"], "00".repeat(1000));
            }
        }
        assert_eq!(messages.last().unwrap()["text"], "Final report 23");
        assert_eq!(reply.data()["message_window"]["has_more"], true);
    }
    polling.await.unwrap()?;
    status_samples.sort();
    views.sort();
    eprintln!(
        "MONITOR-PERF-01: 600 chats, 5000 turns, 300000 events, 24 x 3000 messages, 50000 Works; work-status p50 {:?}, p95 {:?}; session-view p95 under polling {:?}",
        status_samples[5], status_samples[9], views[18]
    );
    assert_history_labels(&s).await?;
    s.finish().await
}
