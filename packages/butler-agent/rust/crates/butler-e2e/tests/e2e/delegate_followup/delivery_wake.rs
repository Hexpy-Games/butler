//! The outbox acknowledgement is the only transition left to wake the user row.
use super::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[tokio::test]
async fn delivered_outbox_wakes_followup_after_result_turn_releases() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let delivered = TcpListener::bind("127.0.0.1:0").await?;
    let held = TcpListener::bind("127.0.0.1:0").await?;
    let (url, script, server) = stub::start(true).await?;
    let s = Setup::new("OUTBOX-DELIVERED-WAKE")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url)
        .env(
            "BUTLER_E2E_RESULT_DELIVERED_BARRIER",
            delivered.local_addr()?.to_string(),
        )
        .env(
            "BUTLER_E2E_QUEUE_WAIT_OBSERVER",
            held.local_addr()?.to_string(),
        )
        .start()
        .await?;
    s.turn("general", stub::OWNER).await?;
    tokio::time::timeout(Duration::from_secs(20), script.held.notified())
        .await
        .unwrap();
    let followup = "Keep the acknowledgement note.";
    let queued =
        s.gw.post(
            "/session-queue",
            json!({"chat_id":"general", "text":followup,
        "client_message_id":uuid::Uuid::new_v4().to_string()}),
        )
        .await?;
    assert_eq!(queued.status, 202, "{queued:?}");
    script.release.notify_one();
    let (mut acknowledgement, _) =
        tokio::time::timeout(Duration::from_secs(30), delivered.accept())
            .await
            .unwrap()?;
    let mut admitted = [0; 8];
    acknowledgement.read_exact(&mut admitted).await?;
    assert_eq!(&admitted, b"admitted");
    let result_turn = wait_result_turn(&s).await?;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let (mut socket, _) = held.accept().await?;
            let mut observed_turn = String::new();
            socket.read_to_string(&mut observed_turn).await?;
            if observed_turn == result_turn {
                return Ok::<_, HarnessError>(());
            }
        }
    })
    .await
    .expect("dispatcher must hold the follow-up after the result releases")?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    let pending: i64 = db
        .query_row(
            "SELECT count(*) FROM btcc_subsession_outbox WHERE status='pending'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(pending, 1);
    assert!(
        !script
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| ordering::request_text(r) == followup)
    );
    acknowledgement.write_all(b"!").await?;
    drop(acknowledgement);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let messages = s.gw.messages("general").await?;
        if messages
            .iter()
            .any(|m| m["role"] == "assistant" && m["text"] == "{}" && m["status"] == "delivered")
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "outbox delivered but queue stuck: {messages:?}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn wait_result_turn(s: &Scenario) -> Result<String, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let messages = s.gw.messages("general").await?;
        if let Some(message) = messages
            .iter()
            .find(|m| m["text"] == "원문 확인 결과를 정리했습니다." && m["status"] == "delivered")
        {
            return Ok(message["turn_id"].as_str().unwrap().into());
        }
        assert!(
            Instant::now() < deadline,
            "result never delivered: {messages:?}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
