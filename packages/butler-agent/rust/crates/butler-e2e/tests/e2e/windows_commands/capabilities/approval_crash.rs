//! A durable decision reconstructs its resume when killed before queue publication.
use super::*;
use rusqlite::Connection;

#[path = "approval_retry.rs"]
mod retry;

// These scenarios require hooks compiled into the target executable.
mod requires_e2e_fixtures {
    use super::*;

    #[tokio::test]
    async fn decision_and_message_survive_kill_before_resume_publication()
    -> Result<(), HarnessError> {
        butler_e2e::gate!();
        for action in ["allow", "deny"] {
            crash_after_decision(action, None).await?;
        }
        Ok(())
    }

    #[tokio::test]
    async fn corrupt_pending_resumes_rebuild_once_without_executing_denials()
    -> Result<(), HarnessError> {
        butler_e2e::gate!();
        for content in [
            b"".as_slice(),
            b"garbage",
            br#"{"version":1,"queueId":"torn"#,
        ] {
            for action in ["allow", "deny"] {
                crash_after_decision(action, Some(content)).await?;
            }
        }
        Ok(())
    }

    async fn crash_after_decision(
        action: &str,
        corrupt: Option<&[u8]>,
    ) -> Result<(), HarnessError> {
        let (mut s, chat, script, server) = setup(Access::AskAlways).await?;
        s.agent.terminate().await?;
        let release = s.sandbox.root.join("publication-release");
        s.agent.launch.env.extend([
            (
                "BUTLER_E2E_HOLD_POINT".into(),
                "reconstructible_file_publish".into(),
            ),
            (
                "BUTLER_E2E_HOLD_RELEASE".into(),
                release.display().to_string(),
            ),
        ]);
        s.gw = s.agent.start_again().await?;
        script.select(Case {
        tool: "write_file",
        args: json!({"path":"decision-survived.txt","content":"approved message","overwrite":false}),
        refused: false,
    });
        let id = s.gw.say_turn(&chat, provider::PROMPT).await?;
        let turn =
            s.gw.wait_turn(&chat, &id, &["waiting_for_form"], Duration::from_secs(15))
                .await?;
        assert_eq!(turn_state(&turn), "waiting_for_form");
        let cards = s.gw.approval_requests(&chat).await?;
        assert_eq!(cards.len(), 1);
        let reference = cards[0]["request_ref"].as_str().unwrap().to_owned();
        // Settle the original suspended dispatch before targeting the decision boundary.
        wait_for(
            &s.sandbox.data.join("runtime/inbound-events/processing"),
            false,
        )
        .await?;
        let gw = s.gw.clone();
        let route = format!("/authority-requests/{reference}/{action}?session_id={chat}");
        let request = tokio::spawn(async move { gw.post(&route, json!({"scope":"once"})).await });
        wait_for(&release.with_extension("held"), true).await?;
        s.agent.kill9()?;
        let _ = request.await;
        assert_decision(&s, &reference, action, &id)?;
        assert!(!s.sandbox.root.join("decision-survived.txt").exists());
        if let Some(bytes) = corrupt {
            std::fs::write(
                s.sandbox
                    .data
                    .join("runtime/inbound-events/pending")
                    .join(format!("idempotent-app_resume_{reference}.json")),
                bytes,
            )?;
        }
        s.agent
            .launch
            .env
            .retain(|(name, _)| !name.starts_with("BUTLER_E2E_HOLD_"));
        s.gw = s.agent.start_again().await?;
        let turn =
            s.gw.wait_terminal(&chat, &id, Duration::from_secs(20))
                .await?;
        assert_eq!(turn_state(&turn), "delivered", "{turn}");
        assert_decision(&s, &reference, action, &id)?;
        let messages = s.gw.messages(&chat).await?;
        assert_eq!(
            messages
                .iter()
                .filter(|message| message["role"] == "user" && message["text"] == provider::PROMPT)
                .count(),
            1
        );
        if action == "allow" {
            assert_eq!(
                std::fs::read_to_string(s.sandbox.root.join("decision-survived.txt"))?,
                "approved message"
            );
        } else {
            assert!(!s.sandbox.root.join("decision-survived.txt").exists());
        }
        assert!(
            script.result.lock().unwrap().is_some(),
            "provider receives resumed result"
        );
        let processed = s
            .sandbox
            .data
            .join("runtime/inbound-events/processed")
            .join(format!("idempotent-app_resume_{reference}.json"));
        wait_for(&processed, true).await?;
        let record: Value = serde_json::from_slice(&std::fs::read(&processed)?)?;
        assert_eq!(record["attempts"], 1, "resume executes exactly once");
        assert_eq!(record["envelope"]["message"]["text"], provider::PROMPT);
        s.finish().await?;
        server.abort();
        Ok(())
    }
}

async fn wait_for(path: &Path, exists: bool) -> Result<(), HarnessError> {
    let started = Instant::now();
    loop {
        let ready = if exists {
            path.exists()
        } else {
            std::fs::read_dir(path)?.next().is_none()
        };
        if ready {
            return Ok(());
        }
        if started.elapsed() > Duration::from_secs(15) {
            return Err(HarnessError(format!(
                "decision boundary not reached: {}",
                path.display()
            )));
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn assert_decision(
    s: &Scenario,
    reference: &str,
    action: &str,
    turn: &str,
) -> Result<(), HarnessError> {
    let db = Connection::open(crate::terminal_history::path(&s.sandbox.data))?;
    let (decision, message): (String, String) = db.query_row(
        "SELECT a.decision,t.original_message FROM btcc_authority_requests a JOIN btcc_turns t ON t.turn_id=a.source_turn_id WHERE a.request_ref=?1 AND t.turn_id=?2",
        [reference, turn], |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    assert_eq!(
        decision,
        if action == "allow" {
            "allowed"
        } else {
            "denied"
        }
    );
    assert_eq!(message, provider::PROMPT);
    Ok(())
}
