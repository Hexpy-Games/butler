//! Deterministic cancellation before permit entry and either settlement order.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::delegate_followup::stub;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Scenario, Setup},
};
use serde_json::json;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
    sync::mpsc,
};

struct Pause {
    point: String,
    stream: TcpStream,
}
impl Pause {
    async fn release(mut self) {
        self.stream.write_all(b"1").await.unwrap();
    }
}
struct Barriers {
    events: mpsc::UnboundedReceiver<Pause>,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for Barriers {
    fn drop(&mut self) {
        self.server.abort();
    }
}
impl Barriers {
    async fn start(db: std::path::PathBuf, entry: &'static str) -> (Self, String) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let (tx, events) = mpsc::unbounded_channel();
        let seen = Arc::new(Mutex::new(std::collections::HashSet::new()));
        let server = tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let (tx, db, seen) = (tx.clone(), db.clone(), seen.clone());
                tokio::spawn(async move {
                    let mut reader = BufReader::new(stream);
                    let mut line = String::new();
                    reader.read_line(&mut line).await.unwrap();
                    let (point, id) = line.trim().split_once('\t').unwrap();
                    let db = rusqlite::Connection::open(&db).unwrap();
                    let child = db.query_row("SELECT EXISTS(SELECT 1 FROM btcc_subsession_delegations WHERE child_turn_id=?1)", [id], |r| r.get::<_, bool>(0)).unwrap();
                    let hold = (child
                        && [entry, "stop_persist", "dispatch_failed"].contains(&point))
                        && seen.lock().unwrap().insert(point.to_owned());
                    let pause = Pause {
                        point: point.into(),
                        stream: reader.into_inner(),
                    };
                    if hold {
                        tx.send(pause).unwrap();
                    } else {
                        pause.release().await;
                    }
                });
            }
        });
        (Self { events, server }, address)
    }
    async fn next(&mut self, point: &str) -> Pause {
        let pause = tokio::time::timeout(Duration::from_secs(30), self.events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(pause.point, point);
        pause
    }
}
#[tokio::test]
async fn stop_fenced_cancel_failed_dispatch_first() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    race(false, "agent_permit").await
}
#[tokio::test]
async fn stop_fenced_cancel_stop_record_first() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    race(true, "agent_permit").await
}
#[tokio::test]
async fn stop_fenced_cancel_at_delivery_reentry_failed_first() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    race(false, "delivery_inserted").await
}
#[tokio::test]
async fn stop_fenced_cancel_at_delivery_reentry_stop_first() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    race(true, "delivery_inserted").await
}
async fn race(stop_first: bool, entry: &'static str) -> Result<(), HarnessError> {
    let delivered = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let (url, script, server) = stub::start(false).await?;
    let setup = Setup::new("TURN-FENCED-CANCEL")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .env(
            "BUTLER_E2E_RESULT_DELIVERED_BARRIER",
            delivered.local_addr()?.to_string(),
        );
    let (mut barriers, address) =
        Barriers::start(setup.sandbox.data.join("agent-runtime/btcc.sqlite"), entry).await;
    let s = setup
        .env("BUTLER_TEST_PAUSE_ADDR", &address)
        .start()
        .await?;
    s.turn("general", stub::OWNER).await?;
    let admitted = barriers.next(entry).await;
    let view = s.gw.get("/session-view?session_id=general").await?;
    let relation = view.data()["steward_children"][0]["relation"]["relation_id"]
        .as_str()
        .unwrap()
        .to_owned();
    // A running child permits parent turns for steering. Hold a real parent
    // request so both follow-ups remain queued throughout the cancellation race.
    s.gw.say("general", stub::BUSY).await?;
    tokio::time::timeout(Duration::from_secs(20), script.busy.notified())
        .await
        .unwrap();
    for text in ["Queued after child 1", "Queued after child 2"] {
        let queued = s.gw.post("/session-queue", json!({"chat_id":"general", "text":text, "client_message_id":uuid::Uuid::new_v4().to_string()})).await?;
        assert_eq!(queued.status, 202);
    }
    let queue = s.gw.get("/session-queue?chat_id=general").await?;
    assert_eq!(
        queue.data()["queued_messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["state"] == "queued" && m["turn_id"].is_null())
            .count(),
        2,
        "{queue:?}"
    );
    let cancel =
        s.gw.post(
            &format!("/steward-relations/{relation}/cancel"),
            json!({"parent_session_id":"general"}),
        )
        .await?;
    assert_eq!(cancel.status, 202, "{cancel:?}");
    let stop = barriers.next("stop_persist").await;
    admitted.release().await;
    let failed = barriers.next("dispatch_failed").await;
    let started = Instant::now();
    if stop_first {
        stop.release().await;
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let processed = s.sandbox.data.join("runtime/inbound-events/processed");
            if std::fs::read_dir(processed)?.any(|entry| {
                let record: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(entry.unwrap().path()).unwrap()).unwrap();
                record.pointer("/envelope/control/kind") == Some(&json!("cancel_turn"))
            }) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "stop did not settle\n{}",
                s.agent.logs()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        failed.release().await;
    } else {
        failed.release().await;
        wait_result(&s, &relation).await?;
        stop.release().await;
    }
    wait_result(&s, &relation).await?;
    // Result persistence precedes App admission. Wait for the actual queued
    // result before releasing the parent, as in delegate_followup::ordering.
    let (mut acknowledgement, _) =
        tokio::time::timeout(Duration::from_secs(30), delivered.accept())
            .await
            .unwrap()?;
    let mut signal = [0; 8];
    acknowledgement.read_exact(&mut signal).await?;
    assert_eq!(&signal, b"admitted");
    acknowledgement.write_all(b"!").await?;
    drop(acknowledgement);
    script.release_busy.notify_one();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let messages = s.gw.messages("general").await?;
        let root = s.sandbox.data.join("runtime/inbound-events");
        let drained = ["pending", "processing"].iter().all(|state| {
            std::fs::read_dir(root.join(state))
                .unwrap()
                .next()
                .is_none()
        });
        let followups: Vec<_> = messages
            .iter()
            .filter(|m| {
                m["role"] == "user"
                    && matches!(
                        m["text"].as_str(),
                        Some("Queued after child 1" | "Queued after child 2")
                    )
            })
            .collect();
        let parent_cancelled = script.requests.lock().unwrap().iter().any(|r| {
            let text = butler_e2e::e2e::matching::key("/v1/responses", r, &Default::default())
                .user_request;
            text.contains("Delegated result") && text.contains("status: cancelled")
        });
        if drained
            && parent_cancelled
            && followups.len() == 2
            && followups.iter().all(|user| {
                messages.iter().any(|m| {
                    m["turn_id"] == user["turn_id"]
                        && m["role"] == "assistant"
                        && m["status"] == "delivered"
                })
            })
        {
            assert_eq!(followups[0]["text"], "Queued after child 1");
            assert_eq!(followups[1]["text"], "Queued after child 2");
            break;
        }
        assert!(
            Instant::now() < deadline,
            "queue did not drain: {messages:?}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    {
        let requests = script.requests.lock().unwrap();
        let results = requests
            .iter()
            .filter(|r| {
                let text = butler_e2e::e2e::matching::key("/v1/responses", r, &Default::default())
                    .user_request;
                text.contains("Delegated result") && text.contains("status: cancelled")
            })
            .count();
        assert_eq!(results, 1, "parent must receive cancellation exactly once");
        let ordered: Vec<_> = requests
            .iter()
            .map(|r| {
                butler_e2e::e2e::matching::key("/v1/responses", r, &Default::default()).user_request
            })
            .filter(|text| {
                text.contains("Delegated result")
                    || matches!(
                        text.as_str(),
                        "Queued after child 1" | "Queued after child 2"
                    )
            })
            .collect();
        assert_eq!(
            ordered.len(),
            3,
            "result and follow-ups run once: {ordered:?}"
        );
        assert!(ordered[0].contains("status: cancelled"), "{ordered:?}");
        assert_eq!(
            &ordered[1..],
            ["Queued after child 1", "Queued after child 2"]
        );
        assert!(
            !requests
                .iter()
                .any(|r| r.to_string().contains("child_turn_interrupted"))
        );
    }
    wait_result(&s, &relation).await?;
    eprintln!(
        "{entry} stop_first={stop_first}: cancelled=1 parent_cancelled=1 queue drained in {} ms",
        started.elapsed().as_millis()
    );
    s.finish().await?;
    server.abort();
    Ok(())
}
async fn wait_result(s: &Scenario, relation: &str) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        let rows: Vec<(String, Option<String>)> = db
            .prepare("SELECT status,failure_key FROM btcc_steward_results WHERE relation_id=?1")?
            .query_map([relation], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        if !rows.is_empty() {
            assert_eq!(rows, vec![("cancelled".into(), None)], "{}", s.agent.logs());
            return Ok(());
        }
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
