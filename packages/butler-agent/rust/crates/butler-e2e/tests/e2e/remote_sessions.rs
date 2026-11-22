//! Run conversations and answer approvals on a registered computer through the main gateway.
use super::{
    access_tiers::{
        self,
        stub::{self, Script, call},
    },
    computer_account::{Deployed, deployed},
};
use butler_e2e::e2e::{
    HarnessError, chatgpt_wire, fake_chatgpt::FakeChatGptAuthority, gateway::turn_state,
    harness_error, stop_intent::StopOnDrop,
};
use reqwest::Method;
use serde_json::json;
use std::{
    fs,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::task::JoinHandle;

async fn remote_chat(
    id: &str,
    access: &str,
) -> Result<
    (
        Deployed,
        Arc<Script>,
        JoinHandle<()>,
        FakeChatGptAuthority,
        String,
    ),
    HarnessError,
> {
    let (url, script, server) = stub::start().await?;
    let authority = FakeChatGptAuthority::start().await?;
    let d = deployed(
        id,
        &[
            ("BUTLER_CHATGPT_AUTH_ISSUER", &authority.issuer),
            ("BUTLER_CHATGPT_API_BASE_URL", &format!("{url}/v1")),
        ],
    )
    .await?;
    let base = format!("/computers/{}/oauth", d.id);
    let start = d
        .api
        .send(Method::POST, &format!("{base}/start"), Some(json!({})), &[])
        .await?;
    assert_eq!(start.status, 200, "{start:?}");
    let flow = start.data();
    let (status, _) = authority.browser(flow).await?;
    assert_eq!(status, 200);
    let flow_id = flow["flow_id"]
        .as_str()
        .ok_or_else(|| harness_error("missing sign-in flow id"))?;
    let path = format!("{base}/{flow_id}");
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let poll = d.api.send(Method::GET, &path, None, &[]).await?;
        if poll.data()["status"] == "completed" {
            break;
        }
        assert_eq!(poll.data()["status"], "pending");
        assert!(Instant::now() < deadline, "sign-in did not complete");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let created = d
        .api
        .send(
            Method::POST,
            "/sessions",
            Some(json!({"kind":"chat","computer_id":d.id})),
            &[],
        )
        .await?;
    assert_eq!(created.status, 201, "{created:?}");
    let chat = created.data()["session"]["id"]
        .as_str()
        .ok_or_else(|| harness_error("missing session id"))?
        .to_owned();
    let catalog =
        d.s.gw
            .get(&format!("/model-catalog?session_id={chat}"))
            .await?;
    assert_eq!(catalog.status, 200, "{catalog:?}");
    let controls =
        d.s.gw
            .patch(
                &format!("/sessions/{chat}/controls"),
                json!({"model":"openai/gpt-6-sol","access_mode":access}),
            )
            .await?;
    assert_eq!(controls.status, 200, "{controls:?}");
    Ok((d, script, server, authority, chat))
}

#[tokio::test]
async fn remote_session_turn_runs_in_the_computer_folder_and_answers_on_the_main()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    const PROMPT: &str = "Write the remote marker.";
    let (d, script, server, authority, chat) =
        remote_chat("REMOTE-SESSION-TURN", "full_access").await?;
    script.rounds.lock().unwrap().insert(PROMPT.into(), vec![json!([
        call("w","write_file",&json!({"path":"remote-marker.txt","content":"remote","create_parents":true})),
        call("a","create_automation",&json!({"title":"x","prompt":"x","schedule":{"type":"interval","interval_seconds":3600}})),
    ])]);
    let turn = d.s.gw.say_turn(&chat, PROMPT).await?;
    let terminal =
        d.s.gw
            .wait_terminal(&chat, &turn, Duration::from_secs(60))
            .await?;
    let requests = script.requests_for(PROMPT);
    assert!(
        !requests.is_empty(),
        "the remote stub received no request for the prompt"
    );
    assert_eq!(turn_state(&terminal), "delivered", "{terminal}");
    assert_eq!(
        fs::read_to_string(d.remote.0.home.join("work/remote-marker.txt"))?,
        "remote"
    );
    assert!(
        d.s.gw
            .messages(&chat)
            .await?
            .iter()
            .any(|message| message["text"] == "Checked.")
    );
    assert!(
        !requests
            .iter()
            .flat_map(chatgpt_wire::functions)
            .any(|tool| matches!(
                tool["name"].as_str(),
                Some("preview_start" | "create_automation" | "browser_open")
            ))
    );
    let db = rusqlite::Connection::open(d.remote.0.data.join("app-server/butler-client.sqlite"))?;
    let count: i64 = db.query_row("SELECT count(*) FROM app_automations", [], |row| row.get(0))?;
    assert_eq!(count, 0);
    drop(db);
    assert!(requests[1]["input"].as_array().unwrap().iter().any(|item| {
        item["type"] == "function_call_output"
            && item["call_id"] == "a"
            && item["output"]
                .as_str()
                .is_some_and(|output| !output.contains(r#""ok":true"#))
    }));
    let canon =
        d.s.gw
            .post(&format!("/sessions/{chat}/canon/x"), json!({}))
            .await?;
    assert_eq!(canon.status, 409);
    assert_eq!(canon.error_code(), Some("remote_session_unsupported"));
    let plain =
        d.s.gw
            .post("/sessions", json!({"kind":"chat","computer_id":d.id}))
            .await?;
    assert_eq!(plain.status, 201, "{plain:?}");
    let project = d
        .api
        .send(
            Method::POST,
            "/sessions",
            Some(json!({"kind":"project","computer_id":d.id})),
            &[],
        )
        .await?;
    assert_eq!(project.status, 400);
    assert_eq!(project.error_code(), Some("invalid_request"));
    let missing = d
        .api
        .send(
            Method::POST,
            "/sessions",
            Some(json!({"kind":"chat","computer_id":"missing"})),
            &[],
        )
        .await?;
    assert_eq!(missing.status, 404);
    assert_eq!(missing.error_code(), Some("computer_not_found"));
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

#[tokio::test]
async fn remote_approval_reaches_the_main_after_the_computer_restarts() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    const PROMPT: &str = "Write the approved marker.";
    let (d, script, server, authority, chat) =
        remote_chat("REMOTE-SESSION-ASK", "ask_first").await?;
    script.rounds.lock().unwrap().insert(
        PROMPT.into(),
        vec![json!([call(
            "w",
            "write_file",
            &json!({"path":"approved-marker.txt","content":"remote","create_parents":true})
        ),])],
    );
    let turn = access_tiers::paused(&d.s, &chat, PROMPT).await?;
    assert!(
        !script.requests_for(PROMPT).is_empty(),
        "the remote stub received no request for the prompt"
    );
    drop(StopOnDrop(d.remote.0.clone()));
    let cards = d.s.gw.approval_requests(&chat).await?;
    assert_eq!(cards.len(), 1, "{cards:?}");
    assert!(cards[0].to_string().contains("approved-marker.txt"));
    access_tiers::approve(&d.s, &chat, "allow").await?;
    access_tiers::delivered(&d.s, &chat, &turn).await?;
    assert!(d.remote.0.home.join("work/approved-marker.txt").is_file());
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
