//! A remote session reads the main's memory: its instructions in the prompt,
//! and searches the main answers while connected.
use super::{
    access_tiers::stub::call, computer_account::Deployed, remote_sessions::remote_chat_on,
};
use butler_e2e::e2e::{HarnessError, gateway::turn_state};
use reqwest::Method;
use serde_json::json;
use std::{path::Path, sync::atomic::Ordering, time::Duration};

const RULE: &str = "Mention quince-copy-4182 in every answer.";
const SAVE: &str = "Remember this instruction for every chat.";

#[tokio::test]
async fn remote_session_prompt_carries_the_main_instructions() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        Path::new("/usr/sbin/sshd").exists(),
        "Requires a local sshd"
    );
    const ASK: &str = "Say hello from the computer.";
    let (d, script, server, authority, chat) =
        remote_chat_on("REMOTE-MEMORY-COPY", "full_access", true).await?;
    script.wait_for_tools.store(true, Ordering::Relaxed);
    script.rounds.lock().unwrap().insert(
        SAVE.into(),
        vec![call(
            "m",
            "update_explicit_memory",
            &json!({"kind":"instruction","text":RULE,"source":SAVE}),
        )],
    );
    let turn = d.s.gw.say_turn("general", SAVE).await?;
    let terminal =
        d.s.gw
            .wait_terminal("general", &turn, Duration::from_secs(90))
            .await?;
    assert_eq!(turn_state(&terminal), "delivered", "{terminal}");
    let listed = d.s.gw.get("/memory/instructions").await?;
    assert!(
        listed.data()["instructions"]
            .as_array()
            .is_some_and(|rows| rows.iter().any(|row| row["text"] == RULE)),
        "{}",
        listed.text
    );
    let start = d
        .api
        .send(
            Method::POST,
            &format!("/computers/{}/start", d.id),
            None,
            &[],
        )
        .await?;
    assert_eq!(start.status, 200, "{start:?}");
    let turn = d.s.gw.say_turn(&chat, ASK).await?;
    let terminal =
        d.s.gw
            .wait_terminal(&chat, &turn, Duration::from_secs(60))
            .await?;
    assert_eq!(turn_state(&terminal), "delivered", "{terminal}");
    let requests = script.requests_for(ASK);
    assert!(
        requests
            .first()
            .is_some_and(|request| request.to_string().contains(RULE)),
        "the remote prompt lacks the main's instruction"
    );
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
