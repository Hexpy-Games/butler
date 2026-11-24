use super::{
    access_tiers, access_tiers::stub::call, computer_account::Deployed,
    remote_sessions::remote_chat,
};
use butler_e2e::e2e::{HarnessError, gateway::turn_state};
use reqwest::Method;
use serde_json::json;
use std::{
    fs,
    path::Path,
    time::{Duration, Instant},
};

#[tokio::test]
async fn session_list_names_the_computer() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    let (d, _, server, authority, chat) =
        remote_chat("REMOTE-SESSION-LIST-NAME", "full_access").await?;
    let list = d.s.gw.get("/sessions").await?;
    assert_eq!(list.status, 200);
    let data = list.data();
    let row = data["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == chat)
        .unwrap();
    assert_eq!(row["computer_id"], d.id);
    assert_eq!(row["computer_name"], "Remote");

    let deleted = d
        .api
        .send(Method::DELETE, &format!("/computers/{}", d.id), None, &[])
        .await?;
    assert_eq!(deleted.status, 200, "{deleted:?}");
    let list = d.s.gw.get("/sessions").await?;
    assert_eq!(list.status, 200);
    let data = list.data();
    let row = data["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == chat)
        .unwrap();
    assert_eq!(row["computer_id"], d.id);
    assert!(row.get("computer_name").is_none(), "{row}");

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
async fn waiting_approval_shows_attention() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    const PROMPT: &str = "Write the approved marker.";
    let (d, script, server, authority, chat) =
        remote_chat("REMOTE-SESSION-LIST-ATTENTION", "ask_first").await?;
    script.rounds.lock().unwrap().insert(
        PROMPT.into(),
        vec![json!([call(
            "w",
            "write_file",
            &json!({"path":"approved-marker.txt","content":"remote","create_parents":true})
        )])],
    );
    let turn = access_tiers::paused(&d.s, &chat, PROMPT).await?;
    let reconnect = d
        .api
        .send(
            Method::POST,
            &format!("/computers/{}/reconnect", d.id),
            None,
            &[],
        )
        .await?;
    assert_eq!(reconnect.status, 200, "{reconnect:?}");
    let wait_for_attention = async |expected: bool| -> Result<(), HarnessError> {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let list = d.s.gw.get("/sessions").await?;
            assert_eq!(list.status, 200);
            let data = list.data();
            let row = data["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["id"] == chat)
                .unwrap();
            let state = row
                .get("active_turn_state")
                .and_then(serde_json::Value::as_str);
            if row["attention_required"] == expected
                && state == expected.then_some("waiting_for_form")
            {
                return Ok(());
            }
            assert!(
                Instant::now() < deadline,
                "expected attention={expected}: {row}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    };
    wait_for_attention(true).await?;
    access_tiers::approve(&d.s, &chat, "allow", None).await?;
    access_tiers::delivered(&d.s, &chat, &turn).await?;
    wait_for_attention(false).await?;

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
async fn open_in_app_copies_a_remote_file() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    const PROMPT: &str = "Write and deliver the remote report.";
    const TEXT: &str = "remote report\n";
    let (d, script, server, authority, chat) =
        remote_chat("REMOTE-SESSION-LIST-FILE", "full_access").await?;
    script.rounds.lock().unwrap().insert(
        PROMPT.into(),
        vec![json!([
            call(
                "report",
                "write_file",
                &json!({"path":"report.txt","content":TEXT,"create_parents":true})
            ),
            call(
                "deliver",
                "deliver_files",
                &json!({"files":[{"path":"report.txt","title":"Report"}]})
            ),
        ])],
    );
    let turn = d.s.gw.say_turn(&chat, PROMPT).await?;
    let terminal =
        d.s.gw
            .wait_terminal(&chat, &turn, Duration::from_secs(60))
            .await?;
    assert_eq!(turn_state(&terminal), "delivered", "{terminal}");

    let db = butler_platform::sqlite::open_with_flags(
        d.remote.0.data.join("app-server/butler-client.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let file_id: String = db.query_row(
        "SELECT id FROM message_files WHERE owner_session_id=?1 AND mime_type LIKE 'text/plain%'",
        [&chat],
        |row| row.get(0),
    )?;
    drop(db);
    let opened =
        d.s.gw
            .post(
                "/internal/opened-files",
                json!({"file_id":file_id,"session_id":chat}),
            )
            .await?;
    assert_eq!(opened.status, 201, "{opened:?}");
    let data = opened.data();
    assert_eq!(data["open"], true);
    assert_eq!(data["original"], false);
    let bytes = fs::read(data["path"].as_str().unwrap())?;
    assert_eq!(bytes, fs::read(d.remote.0.home.join("work/report.txt"))?);

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
