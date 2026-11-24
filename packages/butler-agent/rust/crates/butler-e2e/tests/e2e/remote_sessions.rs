//! Run conversations and answer approvals on a registered computer through the main gateway.
use super::{
    access_tiers::{
        self,
        stub::{self, Script, call},
    },
    computer_account::{Deployed, deployed_with},
};
use butler_e2e::e2e::{
    HarnessError, chatgpt_wire,
    events::{LiveEvents, event_turn_id},
    fake_chatgpt::FakeChatGptAuthority,
    gateway::turn_state,
    harness_error,
    stop_intent::StopOnDrop,
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

pub(super) async fn remote_chat(
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
    remote_chat_on(id, access, false).await
}

pub(super) async fn remote_chat_on(
    id: &str,
    access: &str,
    main_model: bool,
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
    let (d, chat) =
        remote_chat_with_model(id, access, &format!("{url}/v1"), &authority, main_model).await?;
    Ok((d, script, server, authority, chat))
}

pub(super) async fn remote_chat_with_model(
    id: &str,
    access: &str,
    base: &str,
    authority: &FakeChatGptAuthority,
    main_model: bool,
) -> Result<(Deployed, String), HarnessError> {
    let main_env = [("BUTLER_CHATGPT_API_BASE_URL", base)];
    let d = deployed_with(
        id,
        &[
            ("BUTLER_CHATGPT_AUTH_ISSUER", &authority.issuer),
            ("BUTLER_CHATGPT_API_BASE_URL", base),
        ],
        if main_model { main_env.as_slice() } else { &[] },
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
    Ok((d, chat))
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
    let live = LiveEvents::subscribe(&d.s.gw, 0).await?;
    let turn = access_tiers::paused(&d.s, &chat, PROMPT).await?;
    live.wait_for(Duration::from_secs(30), |event| {
        event.get("id").is_none()
            && event["type"] == "turn.state_changed"
            && event_turn_id(event) == Some(&turn)
            && (event["payload"]["turn"]["state"] == "waiting_for_form"
                || event["payload"]["state"] == "waiting_for_form")
    })
    .await?;
    let path = format!("/computers/{}/connection", d.id);
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let reply = d.api.send(Method::GET, &path, None, &[]).await?;
        assert_eq!(reply.status, 200, "{reply:?}");
        if reply.data()["state"] == "idle" {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "waiting relay did not stop: {reply:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        !script.requests_for(PROMPT).is_empty(),
        "the remote stub received no request for the prompt"
    );
    drop(StopOnDrop(d.remote.0.clone()));
    let cards = d.s.gw.approval_requests(&chat).await?;
    assert_eq!(cards.len(), 1, "{cards:?}");
    assert!(cards[0].to_string().contains("approved-marker.txt"));
    access_tiers::approve(&d.s, &chat, "allow", None).await?;
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

#[tokio::test]
async fn remote_output_and_html_file_open_on_the_main() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    const PROMPT: &str = "Publish the remote site and deliver the report.";
    let (d, script, server, authority, chat) =
        remote_chat("REMOTE-SESSION-CONTENT", "full_access").await?;
    script.rounds.lock().unwrap().insert(PROMPT.into(), vec![json!([
        call("index","write_file",&json!({"path":"site/index.html","content":"<h1>remote-output</h1>","create_parents":true})),
        call("big","run_command",&json!({"command":"head -c 4194304 /dev/zero | tr -c a a > site/big.txt","summary":"Make a large file"})),
        call("publish","output_publish",&json!({"path":"site","entry":"index.html","title":"Remote site"})),
        call("report","run_command",&json!({"command":"printf '<p>remote-report</p>' > report.html && head -c 5242880 /dev/zero | tr -c a a >> report.html","summary":"Make a large report"})),
        call("deliver","deliver_files",&json!({"files":[{"path":"report.html","title":"Report"}]})),
    ])]);
    let turn = d.s.gw.say_turn(&chat, PROMPT).await?;
    let terminal =
        d.s.gw
            .wait_terminal(&chat, &turn, Duration::from_secs(60))
            .await?;
    assert_eq!(turn_state(&terminal), "delivered", "{terminal}");

    let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY;
    let db = butler_platform::sqlite::open_with_flags(
        d.remote.0.data.join("agent-runtime/btcc.sqlite"),
        flags,
    )?;
    let raw: String = db.query_row(
        "SELECT result_json FROM btcc_guided_tool_calls WHERE tool_name='output_publish' AND turn_id=?1",
        [&turn], |row| row.get(0),
    )?;
    drop(db);
    let published: serde_json::Value = serde_json::from_str(&raw)?;
    let id = published["output_id"]
        .as_str()
        .ok_or_else(|| harness_error("missing output_id"))?;
    let view =
        d.s.gw
            .get(&format!("/outputs/{id}/view?session_id={chat}"))
            .await?;
    assert_eq!(view.status, 200, "{view:?}");
    let url = view.data()["url"].as_str().unwrap();
    assert!(
        reqwest::get(url)
            .await?
            .text()
            .await?
            .contains("remote-output")
    );
    let big = reqwest::get(url.replace("index.html", "big.txt"))
        .await?
        .bytes()
        .await?;
    assert_eq!(big.len(), 4_194_304);
    assert!(big.iter().all(|&b| b == b'a'));

    let db = butler_platform::sqlite::open_with_flags(
        d.remote.0.data.join("app-server/butler-client.sqlite"),
        flags,
    )?;
    let fid: String = db.query_row(
        "SELECT id FROM message_files WHERE owner_session_id=?1 AND mime_type LIKE 'text/html%'",
        [&chat],
        |row| row.get(0),
    )?;
    drop(db);
    let path = format!("/message-files/{fid}?session_id={chat}");
    let file = d.s.gw.raw(Method::GET, &path, &[]).await?;
    assert_eq!(file.status(), 200);
    assert_eq!(
        file.headers()["content-security-policy"],
        "sandbox; default-src 'none'"
    );
    let bytes = file.bytes().await?;
    assert_eq!(bytes.len(), 5_242_900);
    assert!(bytes.starts_with(b"<p>remote-report</p>"));
    let view =
        d.s.gw
            .get(&format!("/message-files/{fid}/view?session_id={chat}"))
            .await?;
    assert_eq!(view.status, 200, "{view:?}");
    let bytes = reqwest::get(view.data()["url"].as_str().unwrap())
        .await?
        .bytes()
        .await?;
    assert_eq!(bytes.len(), 5_242_900);
    assert!(bytes.starts_with(b"<p>remote-report</p>"));
    let export =
        d.s.gw
            .get(&format!("/transcript-export?session_id={chat}"))
            .await?;
    assert_eq!(export.status, 200, "{export:?}");
    assert_eq!(export.data()["session_id"], chat);
    assert!(export.data()["message_count"].as_u64() >= Some(1));
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
