#![allow(clippy::unwrap_used, reason = "E2E assertions")]

use super::*;
use butler_turn::conversation::{ConversationSourceReader, conversation_store_path};

#[tokio::test]
async fn removing_a_computer_preserves_its_tool_steps_and_display_order() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let (d, script, server, authority, chat) =
        remote_chat_on("REMOTE-TOOL-STEPS", "ask_first", true).await?;
    let command = |id, command| {
        call(
            id,
            "run_command",
            &json!({"command":command,"summary":"Update a file","state_effect":"mutation"}),
        )
    };
    let completed = "Complete the file update.";
    let stopped = "Stop this update before it runs.";
    script.rounds.lock().unwrap().extend([
        (
            completed.into(),
            vec![
                command("written", "echo done > note.txt"),
                command("failed", "exit 1"),
            ],
        ),
        (
            stopped.into(),
            vec![command("stopped", "echo stopped > note.txt")],
        ),
    ]);

    let turn = d.s.gw.say_turn(&chat, completed).await?;
    for target in ["echo done", "exit 1"] {
        let deadline = Instant::now() + Duration::from_secs(60);
        let reference = loop {
            if let Some(card) =
                d.s.gw
                    .approval_requests(&chat)
                    .await?
                    .into_iter()
                    .find(|card| card["approval"].to_string().contains(target))
            {
                break card["request_ref"].as_str().unwrap().to_owned();
            }
            assert!(Instant::now() < deadline, "approval for {target} missing");
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        let reply =
            d.s.gw
                .post(
                    &format!("/authority-requests/{reference}/allow?session_id={chat}"),
                    json!({"scope":"once"}),
                )
                .await?;
        assert_eq!(reply.status, 202, "{reply:?}");
    }
    let done =
        d.s.gw
            .wait_terminal(&chat, &turn, Duration::from_secs(60))
            .await?;
    assert_eq!(turn_state(&done), "delivered", "{done}");

    let cancelled = d.s.gw.say_turn(&chat, stopped).await?;
    let paused =
        d.s.gw
            .wait_turn(
                &chat,
                &cancelled,
                &["waiting_for_form", "failed"],
                Duration::from_secs(60),
            )
            .await?;
    assert_eq!(turn_state(&paused), "waiting_for_form", "{paused}");
    let cancel =
        d.s.gw
            .post(
                &format!("/turns/{cancelled}/cancel?session_id={chat}"),
                json!({}),
            )
            .await?;
    assert_eq!(cancel.status, 202, "{cancel:?}");
    let done =
        d.s.gw
            .wait_terminal(&chat, &cancelled, Duration::from_secs(60))
            .await?;
    assert_eq!(turn_state(&done), "cancelled", "{done}");

    let local = &d.remote.0.data;
    let mut expected = Vec::new();
    for id in [&turn, &cancelled] {
        let stored = super::super::tool_steps::stored_steps(local, id)?;
        let displayed = super::super::tool_steps::displayed_steps(&d.s.gw, &chat, id).await?;
        if id == &cancelled {
            assert_eq!(stored.len(), 1);
            assert_eq!(stored[0].status, None);
            assert_eq!(displayed.len(), 1);
            assert_eq!(displayed[0][2], "cancelled");
        } else {
            assert_eq!(
                stored
                    .iter()
                    .map(|step| step.status.as_deref())
                    .collect::<Vec<_>>(),
                [Some("completed"), Some("failed"),]
            );
        }
        if id == &turn {
            expected.push((id, stored, displayed));
        }
    }
    if let Some(path) = std::env::var_os("BUTLER_E2E_TOOL_STEPS_EXPORT") {
        let reader = ConversationSourceReader::open(&conversation_store_path(local))
            .map_err(|error| HarnessError(error.to_string()))?;
        let mut output = Vec::new();
        let end = reader
            .export_transfer(None, |turn| {
                serde_json::to_writer(&mut output, &turn).unwrap();
                output.push(b'\n');
                true
            })
            .map_err(|error| HarnessError(error.to_string()))?
            .unwrap();
        serde_json::to_writer(&mut output, &json!({"end":end}))?;
        output.push(b'\n');
        fs::write(path, output)?;
    }

    let removed = d
        .api
        .send(Method::DELETE, &format!("/computers/{}", d.id), None, &[])
        .await?;
    assert_eq!(removed.status, 200, "{removed:?}");
    let view =
        d.s.gw
            .get(&format!("/session-view?session_id={chat}"))
            .await?;
    assert_eq!(view.status, 200, "{view:?}");
    for (id, stored, displayed) in expected {
        assert_eq!(
            super::super::tool_steps::stored_steps(&d.s.sandbox.data, id)?,
            stored
        );
        assert_eq!(
            super::super::tool_steps::displayed_steps(&d.s.gw, &chat, id).await?,
            displayed
        );
    }
    let Deployed {
        s,
        remote,
        sshd,
        files,
        ..
    } = d;
    drop((remote, sshd, files, server, authority));
    s.finish().await
}
