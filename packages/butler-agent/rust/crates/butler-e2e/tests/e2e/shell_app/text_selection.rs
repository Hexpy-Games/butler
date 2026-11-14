//! Selection through the native shell's public pointer and clipboard harness.
use super::live_turns::ready_workspace;
use super::*;

/// SHELL-APP-05 — Text selection stays inside one message: chrome never selects, paragraphs
/// copy together, and a drag beyond the user bubble clamps to that message's text.
#[tokio::test]
async fn shell_app_05_text_selection_stays_in_one_message() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-05")?;
    let behavior = ChatBehavior {
        answer: "Alpha first paragraph.\n\nBeta second paragraph.".into(),
        ..Default::default()
    };
    let _model = ready_workspace(&sandbox, behavior).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&["agent running", "wait-anchor composer"])
        .await?;
    let gw = gateway(&shell.launch);
    let created = gw
        .post("/sessions", json!({"kind": "chat", "title": "Selection"}))
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let id = created.data()["session"]["id"]
        .as_str()
        .expect("session id")
        .to_owned();
    shell
        .run(&[
            &format!("wait-anchor sidebar-row-{id}"),
            &format!("open {id}"),
        ])
        .await?;
    let sent = gw
        .post(
            "/messages",
            json!({"chat_id": id, "text": "Hello", "client_message_id": "shell-app-05"}),
        )
        .await?;
    assert_eq!(sent.status, 202, "{}", sent.text);
    shell.run(&["answer Alpha first paragraph."]).await?;
    let response = gw.get(&format!("/session-view?session_id={id}")).await?;
    assert_eq!(response.status, 200, "{}", response.text);
    let view = response.data();
    let messages = view["messages"].as_array().expect("messages");
    let user = messages.iter().find(|m| m["role"] == "user").expect("user")["id"]
        .as_str()
        .expect("user id");
    let assistant = messages
        .iter()
        .find(|m| m["role"] == "assistant")
        .expect("assistant")["id"]
        .as_str()
        .expect("assistant id");
    shell
        .run(&[
            &format!("drag sidebar-row-{id} 60 0"),
            "key secondary-c",
            "expect-clipboard null",
            &format!("drag-from message-{assistant}-body 0 0 1 1"),
            "key secondary-c",
            "expect-clipboard \"Alpha first paragraph.\\n\\nBeta second paragraph.\"",
            &format!("drag-from message-{user}-body 0 0 0.5 4"),
            "key secondary-c",
            "expect-clipboard \"Hello\"",
            "app-quit",
        ])
        .await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
