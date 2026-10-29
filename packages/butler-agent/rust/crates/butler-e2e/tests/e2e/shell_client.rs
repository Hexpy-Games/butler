//! Native shell connection through the real, isolated agent gateway.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
use butler_e2e::e2e::{
    provider::Script,
    scenario::{Access, Scenario, Setup},
    security::AdminClient,
};
use butler_shell_client::{AttachState, AuthorityDecision, PageRequest, ShellClient};
use futures_util::StreamExt;
use serde_json::json;
use std::time::Duration;
type TestError = Box<dyn std::error::Error + Send + Sync>;

mod create;
mod paging;
mod retention;
mod transport;

async fn start(id: &str, rounds: usize, access: Access) -> Result<Scenario, TestError> {
    let setup = Setup::new(id)?
        .data_folder_token()
        .access(access)
        .env("BUTLER_APP_SERVER_PORT", "0")
        .synthetic(Script {
            rounds,
            path_for: Box::new(|_| "approval.txt".into()),
            final_text: "shell answer".into(),
        });
    std::fs::write(setup.sandbox.data.join("approval.txt"), "reviewed content")?;
    let mut s = setup.start().await?;
    // The first bind uses port 0; later restarts keep the discovered listener.
    s.agent
        .launch
        .set_env("BUTLER_APP_SERVER_PORT", s.agent.launch.port.to_string());
    Ok(s)
}

async fn attach(s: &Scenario) -> Result<ShellClient, TestError> {
    match ShellClient::attach(Some(s.sandbox.data.clone())).await? {
        AttachState::Connected(client) => Ok(client),
        AttachState::NotRunning => panic!("started agent was not found"),
    }
}

#[tokio::test]
async fn missing_stale_and_disabled_records_open_no_socket() -> Result<(), TestError> {
    butler_e2e::gate!();
    let setup = Setup::new("SHELL-ABSENT")?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let path = setup
        .sandbox
        .data
        .join("state/butler-agent-native-service.json");
    assert!(matches!(
        ShellClient::attach(Some(setup.sandbox.data.clone())).await?,
        AttachState::NotRunning
    ));
    std::fs::create_dir_all(path.parent().unwrap())?;
    for (pid, state, enabled) in [
        (u32::MAX, "ready", true),
        (std::process::id(), "ready", true),
        (std::process::id(), "starting", true),
        (std::process::id(), "ready", false),
    ] {
        std::fs::write(
            &path,
            serde_json::to_vec(&json!({
                "schema":"butler.native-agent-service-instance.v1", "nonce":"stale", "pid":pid,
                "process_start":"wrong-start", "executable":butler_platform::instance::process_executable(pid).ok().flatten(),
                "state":state,"app_enabled":enabled,"app_endpoint":format!("http://{}",listener.local_addr()?)
            }))?,
        )?;
        assert!(matches!(
            ShellClient::attach(Some(setup.sandbox.data.clone())).await?,
            AttachState::NotRunning
        ));
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(150), listener.accept())
            .await
            .is_err()
    );
    Ok(())
}

#[tokio::test]
async fn attach_page_send_stream_rotate_and_resume() -> Result<(), TestError> {
    butler_e2e::gate!();
    let s = start("SHELL-ROUNDTRIP", 0, Access::FullAccess).await?;
    let client = attach(&s).await?;
    assert!(!format!("{client:?}").contains(&s.gw.token));
    for title in ["first", "second", "third"] {
        assert_eq!(
            s.gw.post("/sessions", json!({"kind":"chat","title":title}))
                .await?
                .status,
            201
        );
    }
    let first = client.list_chats(PageRequest::new(2, None)?).await?;
    let second = client
        .list_chats(PageRequest::new(2, first.next_cursor.clone())?)
        .await?;
    assert_eq!(first.items.len(), 2);
    assert_eq!(second.items.len(), 2);
    assert!(first.next_cursor.is_some());
    assert!(second.next_cursor.is_none());
    assert_eq!(first.items.len() + second.items.len(), 4);
    assert!(
        first
            .items
            .iter()
            .all(|a| !second.items.iter().any(|b| a["id"] == b["id"]))
    );
    let sessions = client.list_sessions(PageRequest::new(2, None)?).await?;
    assert_eq!(sessions.items.len(), 2);
    let mut events = client.live_events(0);
    let accepted = client
        .start_turn("general", "shell-message", "Reply briefly")
        .await?;
    let turn = butler_e2e::e2e::scenario::accepted_turn_id(&accepted)?;
    let turn = turn.as_str();
    let mut ids = Vec::new();
    tokio::time::timeout(Duration::from_secs(60), async {
        while let Some(event) = events.next().await {
            let event = event.unwrap();
            if let Some(id) = event.cursor {
                ids.push(id);
            }
            if delivered(&event.raw, turn) {
                break;
            }
        }
    })
    .await?;
    assert!(ids.windows(2).all(|w| w[0] < w[1]));
    let page = client.get_messages("general", 0).await?;
    assert_eq!(page.messages.len(), 2);
    assert_eq!(page.messages[1]["text"], "shell answer");
    assert_eq!(page.messages[1]["status"], "delivered");
    assert_eq!(
        client
            .get_messages("general", page.next_cursor)
            .await?
            .messages,
        Vec::<serde_json::Value>::new()
    );
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    admin.rotate().await?;
    assert_eq!(
        s.gw.get("/chats").await?.status,
        401,
        "the cached credential must actually be rejected"
    );
    // Client still holds the old token: this request must receive 401 and reload.
    assert_eq!(
        client
            .list_chats(PageRequest::new(2, None)?)
            .await?
            .items
            .len(),
        2
    );
    // Rotation closes the active stream. Continue the same Stream through reconnect.
    let cursor = *ids.last().unwrap();
    let next = client
        .post_message("general", "after-rotation", "Reply briefly again")
        .await?;
    let next_turn = butler_e2e::e2e::scenario::accepted_turn_id(&next)?;
    let next_turn = next_turn.as_str();
    tokio::time::timeout(Duration::from_secs(60), async {
        while let Some(event) = events.next().await {
            let event = event.unwrap();
            if let Some(id) = event.cursor {
                ids.push(id);
            }
            if delivered(&event.raw, next_turn) {
                break;
            }
        }
    })
    .await?;
    assert!(ids.windows(2).all(|w| w[0] < w[1]));
    let replay = client.replay_events(cursor, 200).await?;
    let expected: Vec<_> = replay
        .events
        .iter()
        .filter_map(|v| v["id"].as_u64())
        .take_while(|id| *id <= *ids.last().unwrap())
        .collect();
    assert_eq!(
        ids.iter()
            .copied()
            .filter(|id| *id > cursor)
            .collect::<Vec<_>>(),
        expected
    );
    drop(events);
    Ok(s.finish().await?)
}

#[tokio::test]
async fn approvals_preserve_exact_action_and_allow_or_deny() -> Result<(), TestError> {
    butler_e2e::gate!();
    for allow in [true, false] {
        let s = start("SHELL-APPROVAL", 1, Access::AskAlways).await?;
        let client = attach(&s).await?;
        let accepted = client
            .start_turn("general", "read-file", "Read approval.txt")
            .await?;
        let turn = butler_e2e::e2e::scenario::accepted_turn_id(&accepted)?;
        let turn = turn.as_str();
        s.gw.wait_turn(
            "general",
            turn,
            &["waiting_for_form"],
            Duration::from_secs(30),
        )
        .await?;
        let cards = client.authority_requests("general").await?;
        let original = s.gw.get("/authority-requests?session_id=general").await?;
        assert_eq!(cards.requests.len(), 1);
        let card = &cards.requests[0];
        assert_eq!(card.raw, original.data()["requests"][0]);
        assert_eq!(card.approval, original.data()["requests"][0]["approval"]);
        assert!(card.approval.to_string().contains("approval.txt"));
        assert_eq!(
            card.reason,
            original.data()["requests"][0]["reason"].as_str().unwrap()
        );
        let decision = if allow {
            AuthorityDecision::Allow {
                scope: "once".into(),
            }
        } else {
            AuthorityDecision::Deny
        };
        client
            .answer_authority("general", &card.request_ref, decision)
            .await?;
        let done =
            s.gw.wait_terminal("general", turn, Duration::from_secs(30))
                .await?;
        assert_eq!(done["state"], "delivered");
        s.finish().await?;
    }
    Ok(())
}

fn delivered(event: &serde_json::Value, turn: &str) -> bool {
    event["type"] == "turn.state_changed"
        && butler_e2e::e2e::events::event_turn_id(event) == Some(turn)
        && (event["payload"]["state"] == "delivered"
            || event["payload"]["turn"]["state"] == "delivered")
}

#[tokio::test]
async fn cancel_waiting_turn_through_shell() -> Result<(), TestError> {
    butler_e2e::gate!();
    let s = start("SHELL-CANCEL", 1, Access::AskAlways).await?;
    let client = attach(&s).await?;
    let accepted = client
        .start_turn("general", "cancel-message", "Read approval.txt")
        .await?;
    let turn = butler_e2e::e2e::scenario::accepted_turn_id(&accepted)?;
    s.gw.wait_turn(
        "general",
        &turn,
        &["waiting_for_form"],
        Duration::from_secs(30),
    )
    .await?;
    client.cancel_turn(&turn).await?;
    let done =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(30))
            .await?;
    assert_eq!(done["state"], "cancelled");
    s.finish().await?;
    Ok(())
}

#[tokio::test]
async fn stopped_agent_reattaches_and_resumes_without_gaps() -> Result<(), TestError> {
    butler_e2e::gate!();
    let mut s = start("SHELL-RECONNECT", 0, Access::FullAccess).await?;
    let client = attach(&s).await?;
    let (first_turn, _) = s.turn("general", "First answer").await?;
    let replay = client.replay_events(0, 200).await?;
    let before = replay.next_cursor;
    let mut stream = client.live_events(0);
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut cursor = 0;
        while cursor < before {
            cursor = stream
                .next()
                .await
                .unwrap()
                .unwrap()
                .cursor
                .unwrap_or(cursor);
        }
    })
    .await?;
    s.agent.terminate().await?;
    let mut ids = Vec::new();
    let failure = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match stream.next().await.unwrap() {
                Ok(event) => {
                    if let Some(id) = event.cursor {
                        ids.push(id);
                    }
                }
                Err(error) => break error,
            }
        }
    })
    .await?;
    assert!(matches!(failure, butler_shell_client::Error::Connection));
    assert!(stream.next().await.is_none());
    s.restart().await?;
    let client = attach(&s).await?;
    let mut stream = client.live_events(ids.last().copied().unwrap_or(before));
    s.turn("general", "Second answer").await?;
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            let event = stream.next().await.unwrap().unwrap();
            if let Some(id) = event.cursor {
                ids.push(id);
            }
            let message = &event.raw["payload"]["message"];
            if message["role"] == "assistant"
                && message["status"] == "delivered"
                && message["turn_id"] != first_turn
            {
                assert_eq!(message["text"], "shell answer");
                break;
            }
        }
    })
    .await?;
    let replay = client.replay_events(before, 200).await?;
    let expected: Vec<_> = replay
        .events
        .iter()
        .filter_map(|v| v["id"].as_u64())
        .take_while(|id| *id <= *ids.last().unwrap())
        .collect();
    assert_eq!(ids, expected);
    drop(stream);
    s.finish().await?;
    Ok(())
}

#[tokio::test]
async fn crashed_instance_ends_the_stream_without_a_record_rewrite() -> Result<(), TestError> {
    butler_e2e::gate!();
    let mut s = start("SHELL-CRASH", 0, Access::FullAccess).await?;
    let client = attach(&s).await?;
    let record = s
        .sandbox
        .data
        .join("state/butler-agent-native-service.json");
    let before = std::fs::read(&record)?;
    let mut events = client.live_events(0);
    s.agent.kill9()?;
    let error = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Some(Err(error)) = events.next().await {
                break error;
            }
        }
    })
    .await?;
    assert!(matches!(error, butler_shell_client::Error::Connection));
    assert!(events.next().await.is_none());
    assert_eq!(std::fs::read(record)?, before);
    s.restart().await?;
    let reattached = attach(&s).await?;
    assert_ne!(client.instance_identity(), reattached.instance_identity());
    s.agent.terminate().await?;
    s.finish().await?;
    Ok(())
}
