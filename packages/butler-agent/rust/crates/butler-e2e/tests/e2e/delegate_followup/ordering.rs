//! Results outrank user follow-ups queued during a busy parent turn.
use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn child_result_precedes_queued_followups() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    ordered("/session-queue", false).await
}

#[tokio::test]
async fn child_result_precedes_composer_followups() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    ordered("/messages", false).await
}

#[tokio::test]
async fn quit_with_result_and_followups_queued_preserves_order() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    ordered("/messages", true).await
}

async fn ordered(endpoint: &str, restart: bool) -> Result<(), HarnessError> {
    let delivered = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let (url, script, server) = stub::start(true).await?;
    let mut s = Setup::new("CHILD-RESULT-BEFORE-FOLLOWUPS")?
        .app_supervisor()
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .env(
            "BUTLER_E2E_RESULT_DELIVERED_BARRIER",
            delivered.local_addr()?.to_string(),
        )
        .start()
        .await?;
    s.turn("general", stub::OWNER).await?;
    tokio::time::timeout(Duration::from_secs(20), script.held.notified())
        .await
        .unwrap();
    // A message while the child runs starts a normal parent turn, preserving steering.
    s.gw.say("general", stub::BUSY).await?;
    tokio::time::timeout(Duration::from_secs(20), script.busy.notified())
        .await
        .unwrap();
    let busy_turn = admitted_message_turn(&s, stub::BUSY).await?;
    let followups = ["Keep the first note.", "Keep the second note."];
    for text in followups {
        let queued =
            s.gw.post(
                endpoint,
                json!({
                    "chat_id":"general", "text":text,
                    "client_message_id":uuid::Uuid::new_v4().to_string()
                }),
            )
            .await?;
        assert_eq!(queued.status, 202, "{queued:?}");
        if endpoint == "/messages" {
            assert!(queued.data()["queued"]["id"].is_string(), "{queued:?}");
        } else {
            assert!(
                queued.data()["queued_messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|row| row["text"] == text && row["state"] == "queued"),
                "{queued:?}"
            );
        }
        assert!(queued.data()["accepted"].is_null(), "{queued:?}");
    }
    script.release.notify_one();
    let (mut acknowledgement, _) =
        tokio::time::timeout(Duration::from_secs(30), delivered.accept())
            .await
            .unwrap()?;
    let mut admitted = [0; 8];
    acknowledgement.read_exact(&mut admitted).await?;
    assert_eq!(&admitted, b"admitted");
    assert_pending(&s, &script, &followups).await?;
    acknowledgement.write_all(b"!").await?;
    drop(acknowledgement);
    let cursor =
        s.gw.events_since(0)
            .await?
            .last()
            .and_then(|event| event["id"].as_u64())
            .unwrap_or(0);
    let events = if restart {
        None
    } else {
        Some(butler_e2e::e2e::events::LiveEvents::subscribe(&s.gw, cursor).await?)
    };
    if restart {
        quit(&mut s).await?;
        s.gw = s.agent.start_again().await?;
    } else {
        script.release_busy.notify_one();
        s.gw.wait_terminal("general", &busy_turn, Duration::from_secs(20))
            .await?;
    }
    let events = match events {
        Some(events) => events,
        None => butler_e2e::e2e::events::LiveEvents::subscribe(&s.gw, cursor).await?,
    };
    assert_ordered(&s, &script, &followups, &events).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn admitted_message_turn(s: &Scenario, text: &str) -> Result<String, HarnessError> {
    let events = butler_e2e::e2e::events::LiveEvents::subscribe(&s.gw, 0).await?;
    let message = events
        .wait_for(Duration::from_secs(20), |event| {
            event["type"] == "message.created"
                && event["payload"]["message"]["role"] == "user"
                && event["payload"]["message"]["text"] == text
        })
        .await?;
    Ok(message["payload"]["message"]["turn_id"]
        .as_str()
        .unwrap()
        .into())
}

async fn quit(s: &mut Scenario) -> Result<(), HarnessError> {
    assert!(s.agent.release_foreground_lease());
    let deadline = Instant::now() + Duration::from_secs(10);
    while s.agent.is_running() {
        assert!(
            Instant::now() < deadline,
            "graceful App quit did not finish"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(s.agent.reap().unwrap().success());
    Ok(())
}

async fn assert_pending(
    s: &Scenario,
    script: &stub::Script,
    followups: &[&str],
) -> Result<(), HarnessError> {
    let queue = s.gw.get("/session-queue?chat_id=general").await?;
    let rows = queue.data()["queued_messages"].as_array().unwrap();
    let pending: Vec<_> = rows.iter().filter(|row| row["state"] == "queued").collect();
    assert_eq!(pending.len(), 2, "{queue:?}");
    for text in followups {
        assert!(pending.iter().any(|row| row["text"] == *text), "{queue:?}");
    }
    // Delegated inputs are intentionally hidden from the public queue view.
    // Inspect the durable rows without manufacturing the result or its claim.
    let path = s.sandbox.data.join("app-server/butler-client.sqlite");
    let rows = tokio::task::spawn_blocking(move || {
        let db = butler_platform::sqlite::open(path).unwrap();
        db.prepare("SELECT text,control_resolution_json FROM session_queued_messages WHERE chat_id='general' AND state='queued' ORDER BY rowid")
            .unwrap().query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .unwrap().collect::<Result<Vec<_>, _>>().unwrap()
    }).await.unwrap();
    assert_eq!(rows.len(), 3, "{rows:?}");
    assert_eq!([rows[0].0.as_str(), rows[1].0.as_str()], followups);
    assert!(rows[2].0.contains("Delegated result"), "{rows:?}");
    let controls: Value = serde_json::from_str(&rows[2].1)?;
    assert!(controls["subsession_result"].is_object(), "{controls}");
    assert!(
        !script
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|body| followups.contains(&request_text(body).as_str()))
    );
    Ok(())
}

async fn assert_ordered(
    s: &Scenario,
    script: &stub::Script,
    followups: &[&str],
    events: &butler_e2e::e2e::events::LiveEvents,
) -> Result<(), HarnessError> {
    for text in followups {
        let user = events
            .wait_for(Duration::from_secs(30), |event| {
                event["type"] == "message.created"
                    && event["payload"]["message"]["role"] == "user"
                    && event["payload"]["message"]["text"] == *text
            })
            .await?;
        let turn = user["payload"]["message"]["turn_id"].as_str().unwrap();
        events
            .wait_turn(
                &s.gw,
                "general",
                turn,
                &["delivered"],
                Duration::from_secs(30),
            )
            .await?;
    }
    let messages = s.gw.messages("general").await?;
    let requests = script.requests.lock().unwrap();
    let ordered: Vec<_> = requests
        .iter()
        .map(request_text)
        .filter(|text| text.contains("Delegated result") || followups.contains(&text.as_str()))
        .collect();
    assert_eq!(ordered.len(), 3, "{ordered:?}");
    assert!(
        ordered[0].contains("Delegated result") && ordered[0].contains("status: success"),
        "{ordered:?}"
    );
    assert_eq!(&ordered[1..], followups, "{ordered:?}");
    let result = messages
        .iter()
        .position(|m| m["text"] == "원문 확인 결과를 정리했습니다.")
        .unwrap();
    let users: Vec<_> = followups
        .iter()
        .map(|text| {
            let matches: Vec<_> = messages
                .iter()
                .enumerate()
                .filter(|(_, m)| m["role"] == "user" && m["text"] == *text)
                .collect();
            assert_eq!(
                matches.len(),
                1,
                "follow-up must run exactly once: {matches:?}"
            );
            matches[0].0
        })
        .collect();
    assert!(result < users[0] && users[0] < users[1], "{messages:?}");
    Ok(())
}

pub(super) fn request_text(body: &Value) -> String {
    butler_e2e::e2e::matching::key("/codex/responses", body, &Default::default()).user_request
}
