//! The App following a chat's turn live: the sidebar row and the open transcript.
use super::*;

/// First launch: finish the onboarding through the Agent (`onboardingCompletedPatch`) and make
/// a local model answering with `behavior` the default; the next launch opens the workspace.
async fn ready_workspace(
    sandbox: &Sandbox,
    behavior: ChatBehavior,
) -> Result<FakeServer, HarnessError> {
    let mut shell = Shell::start(sandbox, &[]).await?;
    shell.run(&["agent running"]).await?;
    let gw = gateway(&shell.launch);
    let now = "2026-01-01T00:00:00Z";
    let mut onboarding = gw.settings().await?["onboarding"].clone();
    onboarding["consent_version"] = json!(2);
    onboarding["accepted_at"] = json!(now);
    onboarding["completed_at"] = json!(now);
    let done = gw
        .patch("/settings", json!({"onboarding": onboarding}))
        .await?;
    assert_eq!(done.status, 200, "{}", done.text);
    let model = default_to_local_model(&gw, behavior).await?;
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    Ok(model)
}

/// SHELL-APP-03 — A sidebar row follows its chat's turn live: the working spinner shows while a
/// turn runs and goes when the turn ends (Electron reconciles navigation on turn changes).
#[tokio::test]
async fn shell_app_03_sidebar_row_follows_a_live_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-03")?;
    // A streamed answer slow enough (about 3 s) for the row to show its turn.
    let behavior = ChatBehavior {
        answer: "The row shows this turn while these words stream in one by one. ".repeat(3),
        chunk_delay: Duration::from_millis(100),
        ..ChatBehavior::default()
    };
    let _model = ready_workspace(&sandbox, behavior).await?;

    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&["agent running", "wait-anchor composer"])
        .await?;
    let gw = gateway(&shell.launch);
    let created = gw
        .post("/sessions", json!({"kind": "chat", "title": "Live row"}))
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let id = created.data()["session"]["id"]
        .as_str()
        .expect("session id")
        .to_owned();
    let sent = gw
        .post(
            "/messages",
            json!({"chat_id": id, "text": "Hello", "client_message_id": "shell-app-03"}),
        )
        .await?;
    assert_eq!(sent.status, 202, "{}", sent.text);
    let running = format!("sidebar-running-{id}");
    shell
        .run(&[
            &format!("wait-anchor {running}"),
            &format!("wait-no-anchor {running}"),
            "app-quit",
        ])
        .await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}

/// SHELL-APP-04 — An open chat shows its running turn while a tool runs: the status line (with
/// the Butler mark) shows during the tool step and goes when the turn ends. Electron counts a
/// turn active until its progress state is terminal; a running tool leaves it `running`.
#[tokio::test]
async fn shell_app_04_open_chat_shows_a_running_tool_step() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-04")?;
    // One read-only command that takes a few seconds, then the answer.
    let behavior = ChatBehavior {
        script: vec![
            json!({"role":"assistant","content":null,"tool_calls":[{
                "id":"wait_command","type":"function","function":{
                    "name":"run_command","arguments":json!({
                        "command":"sleep 5","timeout_ms":20_000,
                        "state_effect":"read_only","summary":"Wait a moment"
                    }).to_string()
                }
            }]}),
            json!({"role":"assistant","content":"Done."}),
        ],
        refuse_stream: true,
        local_capabilities: LocalCapabilities {
            ollama: Some(vec!["completion".into(), "tools".into()]),
            ..Default::default()
        },
        ..ChatBehavior::default()
    };
    let _model = ready_workspace(&sandbox, behavior).await?;

    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&["agent running", "wait-anchor composer"])
        .await?;
    let gw = gateway(&shell.launch);
    let created = gw
        .post("/sessions", json!({"kind": "chat", "title": "Tool step"}))
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let id = created.data()["session"]["id"]
        .as_str()
        .expect("session id")
        .to_owned();
    let (row, open) = (
        format!("wait-anchor sidebar-row-{id}"),
        format!("open {id}"),
    );
    shell.run(&[&row, &open]).await?;
    let sent = gw
        .post(
            "/messages",
            json!({"chat_id": id, "text": "Wait a moment, then answer.", "access_mode": "full_access", "client_message_id": "shell-app-04"}),
        )
        .await?;
    assert_eq!(sent.status, 202, "{}", sent.text);
    shell
        .run(&[
            "wait-anchor turn-status",
            "wait-no-anchor turn-status",
            "app-quit",
        ])
        .await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
