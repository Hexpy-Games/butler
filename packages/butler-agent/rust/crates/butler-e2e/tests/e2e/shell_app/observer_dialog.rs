//! The activity dialog (the eye on a steward card) through the native shell.
use super::driver::{SERIAL, SHOTS, Shell};
use super::live_turns::complete_onboarding;
use super::*;
use crate::steward_presentation::{setup, stub};

/// What the App needs of the finished child: its session, the turn its steps belong to and its
/// reply message.
struct Child {
    session: String,
    turn: String,
    reply: String,
}

/// A chat whose steward child has finished with a reply and step rows, through the stub model of
/// `steward_presentation`; the Agent is stopped, so the App starts it on the same data.
async fn finished_child(id: &str) -> Result<(Sandbox, String, Child), HarnessError> {
    let (url, script, server) = stub::start().await?;
    script.release.notify_one();
    let setup = setup(id, &url)?.data_folder_token();
    for name in ["a.txt", "b.txt"] {
        std::fs::write(setup.sandbox.data.join(name), name)?;
    }
    *script.workspace.lock().unwrap() = setup.sandbox.data.display().to_string();
    let mut s = setup.start().await?;
    complete_onboarding(&s.gw).await?;
    let created =
        s.gw.post("/sessions", json!({"kind": "chat", "title": "Compare"}))
            .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let chat = created.data()["session"]["id"]
        .as_str()
        .expect("session id")
        .to_owned();
    s.turn(&chat, stub::OWNER).await?;
    let deadline = Instant::now() + Duration::from_secs(60);
    let session = loop {
        let view =
            s.gw.get(&format!("/session-view?session_id={chat}"))
                .await?;
        let child = &view.data()["steward_children"][0];
        if child["result"].is_object() {
            break child["session_id"]
                .as_str()
                .expect("child session")
                .to_owned();
        }
        assert!(Instant::now() < deadline, "{view:?}\n{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let view =
        s.gw.get(&format!("/session-view?session_id={session}"))
            .await?;
    let view = view.data();
    let reply = view["messages"]
        .as_array()
        .and_then(|all| all.iter().find(|m| m["role"] == "assistant"))
        .expect("the child's reply");
    // The dialog's `turn-activity-<turn>` row exists only when the turn's rows hold phase
    // activities (model-authored decisions with a summary).
    let turn = view["latest_turn"]["id"].as_str().expect("latest turn");
    assert!(
        view["latest_turn"]["progress"]["safe_progress_rows"]
            .as_array()
            .is_some_and(|rows| rows.iter().any(|row| {
                row["work_decision_source"] == "model-authored"
                    && row["work_decision_summary"]
                        .as_str()
                        .is_some_and(|summary| !summary.is_empty())
            })),
        "{view}"
    );
    let child = Child {
        session,
        turn: turn.to_owned(),
        reply: reply["id"].as_str().expect("reply id").to_owned(),
    };
    s.agent.cli_reaping(&["stop", "--json"]).await?;
    server.abort();
    let butler_e2e::e2e::scenario::Scenario { sandbox, .. } = s;
    Ok((sandbox, chat, child))
}

/// SHELL-APP-09 — The eye on a steward card opens the activity dialog, and the dialog shows the
/// child's work: the turn's first activity row and the child's reply are inside the dialog, in
/// view right after it opens (Electron's `SessionObserverDialog`).
#[tokio::test]
async fn shell_app_09_activity_dialog_shows_the_childs_steps_and_reply() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let (mut sandbox, chat, child) = finished_child("SHELL-APP-09").await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    let (row, open) = (
        format!("wait-anchor sidebar-row-{chat}"),
        format!("open {chat}"),
    );
    let eye = format!("steward-observer-open-{}", child.session);
    let (steps, reply) = (
        format!("turn-activity-{}", child.turn),
        format!("message-{}", child.reply),
    );
    shell
        .run(&[
            "agent running",
            &row,
            &open,
            // Tall enough that the card, and its eye, sit below the title bar's window controls.
            "size 800 1400",
            &format!("wait-anchor {eye}"),
            &format!("click {eye}"),
            "wait-anchor dialog-content",
            "wait-anchor steward-observer-transcript",
            &format!("wait-anchor {steps}"),
            &format!("expect-within {steps} dialog-content"),
            &format!("wait-anchor {reply}"),
            &format!("expect-within {reply} dialog-content"),
            "app-quit",
        ])
        .await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
