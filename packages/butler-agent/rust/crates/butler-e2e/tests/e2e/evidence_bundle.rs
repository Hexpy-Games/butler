//! Evidence delivery and exact retrieval through a real stub delegation and reader.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
mod reader;
use super::delegate_followup::stub;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Scenario, Setup},
};
use rusqlite::{Connection, params};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};

const ITEMS: usize = 505;
const SUMMARY: &str = "Original evidence: paper A verified.";

struct Run {
    scenario: Scenario,
    script: Arc<stub::Script>,
    server: tokio::task::JoinHandle<()>,
    bundle: String,
    refs: Vec<String>,
}
impl Run {
    async fn finish(self) -> Result<(), HarnessError> {
        self.scenario.finish().await?;
        self.server.abort();
        Ok(())
    }
}
async fn setup() -> Result<Run, HarnessError> {
    let (url, script, server) = stub::start(true).await?;
    let scenario = Setup::new("EVIDENCE-BUNDLE")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .start()
        .await?;
    scenario.turn("general", stub::OWNER).await?;
    tokio::time::timeout(Duration::from_secs(30), script.held.notified())
        .await
        .unwrap();
    let db = Connection::open(scenario.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    seed(&db)?;
    script.release.notify_one();
    let mut bundle = String::new();
    let mut refs = Vec::new();
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let rows = scenario.gw.turns("general").await.unwrap();
            if rows.len() >= 2 && rows.iter().all(|t| matches!(butler_e2e::e2e::gateway::turn_state(t), "delivered")) {
                let (id, raw): (String, String) = db.query_row(
                    "SELECT result_id,acceptance_evidence_json FROM btcc_steward_results LIMIT 1", [],
                    |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
                bundle = format!("evidence:{id}");
                refs = serde_json::from_str(&raw).unwrap();
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }).await.expect("result delivered");
    Ok(Run {
        scenario,
        script,
        server,
        bundle,
        refs,
    })
}

/// Large durable journal fixture, attached before the real disposition snapshots it.
fn seed(db: &Connection) -> Result<(), HarnessError> {
    let (work, turn): (String, String) = db.query_row(
        "SELECT root_work_id,child_turn_id FROM btcc_subsession_delegations LIMIT 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let sequence: i64 = db.query_row(
        "SELECT COALESCE(max(sequence),0) FROM btcc_guided_work_results WHERE work_id=?1",
        [&work],
        |r| r.get(0),
    )?;
    for index in 0..ITEMS {
        let call = format!("bundle-call-{index:04}");
        let reference = format!("bundle-ref-{index:04}");
        let tool = if index % 2 == 0 {
            "web_read"
        } else {
            "web_search"
        };
        let source = format!("https://host{}.example/page/{index}", index % 7);
        let args = match index % 4 {
            0 => serde_json::json!({"url":"https://requested.example/start"}),
            2 => serde_json::json!({"tab":format!("tab-{index}")}),
            _ => serde_json::json!({"query":format!("source {index}")}),
        }
        .to_string();
        let body = serde_json::json!({"ok":true,"index":index,"source_url":source,"text":"Original bytes 한글\r\n".repeat(if index == 0 { 600 } else { 1 })})
            .to_string();
        db.execute("INSERT INTO btcc_guided_tool_calls(call_id,turn_id,tool_name,raw_arguments,arguments_json,status,result_json,result_sha256,started_at) VALUES(?1,?2,?3,?4,?4,'completed',?5,?6,'now')", params![call, turn, tool, args, body, (index != 1).then(|| format!("{:x}",Sha256::digest(body.as_bytes())))])?;
        db.execute("INSERT INTO btcc_guided_work_results(result_ref,work_id,sequence,tool_call_id,origin_turn_id,attached_at) VALUES(?1,?2,?3,?4,?5,'now')", params![reference,work,sequence+i64::try_from(index).unwrap()+1,call,turn])?;
    }
    Ok(())
}

fn text(body: &Value) -> String {
    body["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|item| item["content"].as_array())
        .flatten()
        .filter_map(|part| part["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}
fn parent_request(run: &Run) -> String {
    let requests = run.script.requests.lock().unwrap();
    requests
        .iter()
        .rev()
        .map(text)
        .find(|t| t.contains("from: delegated task"))
        .unwrap()
}

#[tokio::test]
async fn evb_01_large_result_has_a_bounded_mechanical_manifest() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let run = setup().await?;
    let input = parent_request(&run);
    let line = input
        .lines()
        .find(|l| l.starts_with("evidence: evidence:"))
        .unwrap();
    assert!(line.len() <= 3 * 1024, "{} bytes", line.len());
    assert!(line.contains("web_read 253 from 7 sites"), "{line}");
    assert!(line.contains("web_search 252"), "{line}");
    assert!(run.refs.len() >= ITEMS);
    assert!(!input.contains(&serde_json::to_string(&run.refs)?));
    assert!(!input.contains("evidence_refs: ["));
    assert_eq!(input.matches(&run.bundle).count(), 1);
    eprintln!(
        "EVB-01: {} items; manifest {} bytes; parent {} bytes",
        run.refs.len(),
        line.len(),
        input.len()
    );
    run.finish().await
}

#[tokio::test]
async fn evb_04_result_body_is_projected_once_per_parent_request() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let run = setup().await?;
    let input = parent_request(&run);
    assert_eq!(
        input.matches(&format!("summary: {SUMMARY}")).count(),
        1,
        "{input}"
    );
    assert!(input.contains("prior_result_ref:"), "{input}");
    run.scenario
        .turn("general", "Show the prior result.")
        .await?;
    let input = {
        let requests = run.script.requests.lock().unwrap();
        let actor = requests
            .iter()
            .rev()
            .find(|body| {
                butler_e2e::e2e::chatgpt_wire::functions(body)
                    .next()
                    .is_some()
            })
            .expect("follow-up actor request");
        text(actor)
    };
    assert_eq!(
        input.matches(&format!("summary: {SUMMARY}")).count(),
        1,
        "{input}"
    );
    assert!(input.contains("prior_result_ref:"), "{input}");
    run.finish().await
}
