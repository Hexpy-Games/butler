//! Follow-up connection cards for chat-driven computer registration.
#![allow(clippy::unwrap_used, reason = "test assertions")]

use super::{
    ask_user::{pending, reply},
    computer_chat::{ALIAS, add_questions, bridge, listed, result, ssh_fixture, start},
};
use butler_e2e::e2e::{
    HarnessError,
    gateway::turn_state,
    scenario::{Scenario, Setup},
    sshd::{TestSshd, user_ssh_config},
};
use butler_platform::sqlite;
use rusqlite::OpenFlags;
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    net::TcpListener,
    path::Path,
    process::Command,
    time::{Duration, Instant},
};

async fn next_card(
    s: &Scenario,
    turn: &str,
    previous_ref: &str,
    questions: Value,
) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let view = s.gw.get("/session-view?session_id=general").await?;
        assert_eq!(view.status, 200, "{}", view.text);
        let active = &view.data()["active_turn"];
        let card = &view.data()["pending_questions"][0];
        if card["request_ref"]
            .as_str()
            .is_some_and(|reference| reference != previous_ref)
            && active["id"] == turn
            && turn_state(active) == "waiting_for_form"
        {
            assert_eq!(card["questions"], questions);
            return Ok(card.clone());
        }
        assert!(Instant::now() < deadline, "{}", view.text);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn chat_add_asks_for_a_key_file_after_key_login_fails() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let setup = Setup::new("COMPUTER-CHAT-RETRY-KEY")?;
    let home = &setup.sandbox.home;
    let config = user_ssh_config(home)?;
    fs::create_dir_all(home.join("keys"))?;
    let key = home.join("keys/studio");
    let wrong_key = home.join(".ssh/other_ed25519");
    for key in [&key, &wrong_key] {
        let generated = Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-f"])
            .arg(key)
            .output()?;
        assert!(generated.status.success());
    }
    let sshd = TestSshd::start(&home.join("sshd"), &key.with_extension("pub"), Some(home))?;
    writeln!(
        fs::OpenOptions::new().append(true).open(&config)?,
        "\nHost studio-nokey\n  HostName 127.0.0.1\n  Port {}\n  IdentityFile {}\n  IdentitiesOnly yes",
        sshd.port,
        wrong_key.display()
    )?;
    let host = fs::read_to_string(sshd.host_key.with_extension("pub"))?;
    let host_key = host
        .split_whitespace()
        .take(2)
        .collect::<Vec<_>>()
        .join(" ");
    fs::write(
        home.join(".ssh/known_hosts"),
        format!("[127.0.0.1]:{} {host_key}\n", sshd.port),
    )?;
    let (_server, s, api) = start(
        setup.env(
            butler_platform::remote_ssh::CONFIG_FIXTURE,
            config.to_string_lossy(),
        ),
        vec![bridge(
            "add",
            "computer_add",
            &json!({
                "name":"Studio","address":"studio-nokey","folder":"~","model":"none"
            }),
        )],
    )
    .await?;
    let turn = s.gw.say_turn("general", "Add my Studio computer.").await?;
    let card = pending(&s, &turn, add_questions("studio-nokey")).await?;
    reply(
        &s,
        &card,
        json!({"status":"answered","answers":[
            {"id":"computer_add.name","selected":["proposed"],"custom":null},
            {"id":"computer_add.address","selected":["proposed"],"custom":null},
            {"id":"computer_add.folder","selected":["proposed"],"custom":null},
            {"id":"computer_add.model","selected":["model:none"],"custom":null}
        ]}),
    )
    .await?;
    let retry = next_card(&s, &turn, card["request_ref"].as_str().unwrap(), json!({"questions":[
        {"id":"computer_add:ssh_auth_failed.port","eyebrow":"포트",
         "title":"키로 로그인할 수 없습니다. Studio의 포트","kind":"single","allow_custom":true,
         "options":[{"id":"none","label":"설정 안 함"}]},
        {"id":"computer_add:ssh_auth_failed.key_file","eyebrow":"키 파일",
         "title":"키로 로그인할 수 없습니다. Studio의 키 파일","kind":"single","allow_custom":true,
         "options":[{"id":"none","label":"설정 안 함"}]}
    ]})).await?;
    assert_eq!(listed(&api).await?, json!([]));
    reply(
        &s,
        &retry,
        json!({"status":"answered","answers":[
            {"id":"computer_add:ssh_auth_failed.port","selected":["none"],"custom":null},
            {"id":"computer_add:ssh_auth_failed.key_file","selected":[],"custom":key}
        ]}),
    )
    .await?;
    let output = result(&s, &turn).await?;
    assert_eq!(output["ok"], true, "{output}");
    assert_eq!(output["retry"], "answered");
    assert_eq!(output["start_error"]["code"], "release_not_found");
    assert_eq!(output["computer"]["key_file"], json!(key));
    assert_eq!(output["computer"]["port"], Value::Null);
    let computers = listed(&api).await?;
    assert_eq!(computers[0]["id"], output["computer"]["id"]);
    assert_eq!(computers[0]["key_file"], json!(key));
    assert_eq!(computers[0]["port"], Value::Null);
    s.finish().await
}

#[tokio::test]
async fn chat_add_asks_for_a_port_after_connection_fails() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let setup = Setup::new("COMPUTER-CHAT-RETRY-PORT")?;
    let (sshd, config) = ssh_fixture(&setup)?;
    let closed = TcpListener::bind("127.0.0.1:0")?.local_addr()?.port();
    let key = setup.sandbox.home.join(".ssh/id_ed25519");
    writeln!(
        fs::OpenOptions::new().append(true).open(&config)?,
        "\nHost studio-closed\n  HostName 127.0.0.1\n  Port {closed}\n  IdentityFile {}\n  IdentitiesOnly yes",
        key.display()
    )?;
    let args = json!({
        "name":"Studio","address":"studio-closed","folder":"~","model":"none","port":sshd.port
    });
    let (_server, s, api) = start(
        setup.env(butler_platform::remote_ssh::CONFIG_FIXTURE, config),
        vec![
            bridge("cancel", "computer_add", &args),
            bridge("retry", "computer_add", &args),
            bridge(
                "duplicate",
                "computer_add",
                &json!({
                    "name":"Studio","address":ALIAS,"folder":"~/missing","model":"none"
                }),
            ),
        ],
    )
    .await?;
    let proposals = json!({"status":"answered","answers":[
        {"id":"computer_add.name","selected":["proposed"],"custom":null},
        {"id":"computer_add.address","selected":["proposed"],"custom":null},
        {"id":"computer_add.folder","selected":["proposed"],"custom":null},
        {"id":"computer_add.model","selected":["model:none"],"custom":null}
    ]});
    let questions = json!({"questions":[
        {"id":"computer_add:ssh_unreachable.port","eyebrow":"포트",
         "title":"연결할 수 없습니다. Studio의 포트","kind":"single","allow_custom":true,
         "options":[{"id":"proposed","label":sshd.port.to_string(),"recommended":true},
                    {"id":"none","label":"설정 안 함"}]},
        {"id":"computer_add:ssh_unreachable.key_file","eyebrow":"키 파일",
         "title":"연결할 수 없습니다. Studio의 키 파일","kind":"single","allow_custom":true,
         "options":[{"id":"none","label":"설정 안 함"}]}
    ]});
    let turn = s.gw.say_turn("general", "Add my Studio computer.").await?;
    let card = pending(&s, &turn, add_questions("studio-closed")).await?;
    reply(&s, &card, proposals.clone()).await?;
    let retry = next_card(
        &s,
        &turn,
        card["request_ref"].as_str().unwrap(),
        questions.clone(),
    )
    .await?;
    reply(&s, &retry, json!({"status":"answered","answers":[
        {"id":"computer_add:ssh_unreachable.port","selected":[],"custom":null,"skipped":true},
        {"id":"computer_add:ssh_unreachable.key_file","selected":[],"custom":null,"skipped":true}
    ]})).await?;
    let mut value = result(&s, &turn).await?;
    value.as_object_mut().unwrap().remove("bridge_invocation");
    assert_eq!(
        value,
        json!({
            "ok":false,"error":{"code":"ssh_unreachable","message":"Could not reach this computer."},
            "retry":"cancelled"
        })
    );
    assert_eq!(listed(&api).await?, json!([]));

    let turn = s.gw.say_turn("general", "Try adding Studio again.").await?;
    let card = pending(&s, &turn, add_questions("studio-closed")).await?;
    reply(&s, &card, proposals.clone()).await?;
    let first_ref = card["request_ref"].as_str().unwrap();
    let retry = next_card(&s, &turn, first_ref, questions).await?;
    reply(
        &s,
        &retry,
        json!({"status":"answered","answers":[
            {"id":"computer_add:ssh_unreachable.port","selected":["proposed"],"custom":null},
            {"id":"computer_add:ssh_unreachable.key_file","selected":["none"],"custom":null}
        ]}),
    )
    .await?;
    let output = result(&s, &turn).await?;
    assert_eq!(output["ok"], true, "{output}");
    assert_eq!(output["retry"], "answered");
    assert_eq!(output["computer"]["port"], sshd.port);
    let computers = listed(&api).await?;
    assert_eq!(computers[0]["id"], output["computer"]["id"]);
    assert_eq!(computers[0]["port"], sshd.port);

    let turn =
        s.gw.say_turn("general", "Add another computer named Studio.")
            .await?;
    let mut questions = add_questions(ALIAS);
    questions["questions"][2]["options"][0]["label"] = json!("~/missing");
    let card = pending(&s, &turn, questions).await?;
    reply(&s, &card, proposals).await?;
    let output = result(&s, &turn).await?;
    assert_eq!(output["error"]["code"], "computer_name_taken");
    assert!(output.get("retry").is_none());
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(view.status, 200, "{}", view.text);
    assert_eq!(view.data()["pending_questions"], json!([]));
    let db = sqlite::open_with_flags(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    for reference in [first_ref, retry["request_ref"].as_str().unwrap()] {
        let outcome: String = db.query_row(
            "SELECT outcome FROM btcc_authority_requests WHERE request_ref=?1",
            [reference],
            |row| row.get(0),
        )?;
        assert_eq!(outcome, "applied");
    }
    drop(db);
    s.finish().await
}
