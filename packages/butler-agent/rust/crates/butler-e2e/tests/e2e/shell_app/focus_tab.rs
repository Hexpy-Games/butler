//! Keyboard focus order through the native shell.
use super::live_turns::ready_workspace;
use super::*;

/// SHELL-APP-18 — Tab moves keyboard focus like the browser: a click on a message's copy button
/// shows no ring; Tab then walks the tab stops in order, each showing its keyboard ring, through
/// the composer field and its toolbar buttons; Shift-Tab goes back one.
#[tokio::test]
async fn shell_app_18_tab_moves_keyboard_focus_like_the_browser() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-18")?;
    let behavior = ChatBehavior {
        script: vec![
            json!({"role":"assistant","content":null,"tool_calls":[{
                "id":"step","type":"function","function":{
                    "name":"run_command","arguments":json!({
                        "command":"true","timeout_ms":20_000,
                        "state_effect":"read_only","summary":"Check"
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
        .post("/sessions", json!({"kind": "chat", "title": "Tab"}))
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
            json!({"chat_id": id, "text": "Hello", "client_message_id": "shell-app-18"}),
        )
        .await?;
    assert_eq!(sent.status, 202, "{}", sent.text);
    shell.run(&["approval", "allow", "answer Done."]).await?;
    let view = gw.get(&format!("/session-view?session_id={id}")).await?;
    let view = view.data();
    let messages = view["messages"].as_array().expect("messages");
    let of = |role: &str| {
        messages.iter().find(|m| m["role"] == role).expect(role)["id"]
            .as_str()
            .expect("id")
            .to_owned()
    };
    let (user, assistant) = (of("user"), of("assistant"));
    let turn = view["latest_turn"]["id"].as_str().expect("turn").to_owned();
    let header = format!("turn-activity-{turn}-header");
    shell
        .run(&[
            &format!("click user-copy-{user}"),
            "expect-no-focus-ring",
            "key tab",
            &format!("expect-focus-ring {header}"),
            "key tab",
            &format!("expect-focus-ring copy-{assistant}"),
            "key tab",
            "expect-composer-focus",
            "key tab",
            "expect-focus-ring attachment-menu",
            "key tab",
            "expect-focus-ring access-menu",
            "key shift-tab",
            "expect-focus-ring attachment-menu",
        ])
        .await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
