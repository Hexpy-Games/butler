//! Startup retries every decided resume despite one filesystem enqueue error.
use super::*;

#[tokio::test]
async fn retry_decided_enqueues_other_resumes_and_retains_the_failed_decision()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, first, script, server) = setup(Access::AskAlways).await?;
    let project: String = Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?
        .query_row("SELECT project_id FROM chats WHERE id=?1", [&first], |r| {
            r.get(0)
        })?;
    let mut requests = Vec::new();
    for index in 0..4 {
        let chat = if index == 0 {
            first.clone()
        } else {
            let reply =
                s.gw.post("/sessions", json!({"kind":"project","project_id":project}))
                    .await?;
            assert_eq!(reply.status, 201, "{}", reply.text);
            reply.data()["session"]["id"].as_str().unwrap().to_owned()
        };
        script.select(Case { tool: "write_file",
            args: json!({"path":"denied-recovery.txt","content":"must not execute","overwrite":false}),
            refused: false });
        let turn = s.gw.say_turn(&chat, provider::PROMPT).await?;
        s.gw.wait_turn(&chat, &turn, &["waiting_for_form"], Duration::from_secs(15))
            .await?;
        let cards = s.gw.approval_requests(&chat).await?;
        assert_eq!(cards.len(), 1);
        requests.push((
            chat,
            turn,
            cards[0]["request_ref"].as_str().unwrap().to_owned(),
        ));
    }
    wait_for(
        &s.sandbox.data.join("runtime/inbound-events/processing"),
        false,
    )
    .await?;
    s.agent.terminate().await?;
    plant_decisions(&s, &requests)?;
    let queue = s.sandbox.data.join("runtime/inbound-events");
    let names: Vec<_> = requests
        .iter()
        .map(|(_, _, reference)| format!("idempotent-app_resume_{reference}.json"))
        .collect();
    for (index, bytes) in [
        (0, b"".as_slice()),
        (2, b"garbage"),
        (3, br#"{"version":1,"queueId":"torn"#),
    ] {
        std::fs::write(queue.join("pending").join(&names[index]), bytes)?;
    }
    // A directory at one terminal record path makes only that enqueue fail.
    let obstruction = queue.join("processed").join(&names[1]);
    std::fs::create_dir_all(&obstruction)?;
    s.gw = s.agent.start_again().await?;
    let mut completed = Vec::new();
    for index in [0, 2, 3] {
        assert_resumed(&s, &requests[index], &names[index]).await?;
        completed.push((
            index,
            std::fs::read(queue.join("processed").join(&names[index]))?,
        ));
    }
    let logs = s.agent.current_logs().await?;
    assert!(
        logs.contains("resume enqueue failed") && logs.contains(&requests[1].2),
        "{logs}"
    );
    assert!(!queue.join("pending").join(&names[1]).exists());
    assert_decision(&s, &requests[1].2, "deny", &requests[1].1)?;
    assert!(!s.sandbox.root.join("denied-recovery.txt").exists());
    s.agent.terminate().await?;
    std::fs::remove_dir(&obstruction)?;
    s.gw = s.agent.start_again().await?;
    assert_resumed(&s, &requests[1], &names[1]).await?;
    for (index, bytes) in completed {
        assert_eq!(
            std::fs::read(queue.join("processed").join(&names[index]))?,
            bytes,
            "successful resumes are not republished on the next recovery"
        );
    }
    assert!(!s.sandbox.root.join("denied-recovery.txt").exists());
    s.finish().await?;
    server.abort();
    Ok(())
}

fn plant_decisions(
    s: &Scenario,
    requests: &[(String, String, String)],
) -> Result<(), HarnessError> {
    // Seed the durable post-decision/pre-publication crash state while stopped.
    let mut db = Connection::open(crate::terminal_history::path(&s.sandbox.data))?;
    db.pragma_update(None, "synchronous", "FULL")?;
    butler_platform::sqlite::with_fullfsync(&mut db, |db| -> rusqlite::Result<()> {
        let tx = db.transaction()?;
        for (index, (_, _, reference)) in requests.iter().enumerate() {
            assert_eq!(tx.execute("UPDATE btcc_authority_requests SET decision='denied', updated_at=?1 WHERE request_ref=?2 AND decision='pending'",
                [format!("2026-10-16T00:00:0{index}Z"), reference.clone()])?, 1);
        }
        tx.commit()
    })??;
    Ok(())
}

async fn assert_resumed(
    s: &Scenario,
    request: &(String, String, String),
    name: &str,
) -> Result<(), HarnessError> {
    let (chat, turn, reference) = request;
    let done =
        s.gw.wait_terminal(chat, turn, Duration::from_secs(20))
            .await?;
    assert_eq!(turn_state(&done), "delivered", "{done}");
    assert_decision(s, reference, "deny", turn)?;
    let path = s
        .sandbox
        .data
        .join("runtime/inbound-events/processed")
        .join(name);
    wait_for(&path, true).await?;
    let record: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    assert_eq!(record["attempts"], 1);
    assert_eq!(record["envelope"]["message"]["text"], provider::PROMPT);
    assert_eq!(
        s.gw.messages(chat)
            .await?
            .iter()
            .filter(|m| m["role"] == "user" && m["text"] == provider::PROMPT)
            .count(),
        1
    );
    Ok(())
}
