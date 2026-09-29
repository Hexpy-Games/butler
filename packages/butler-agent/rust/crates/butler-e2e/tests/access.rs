//! Ask-first access (owner decision #236): ask-first is the default and asks
//! before every effect except three actions, which proceed without an
//! approval: first-conversation onboarding (ACC-01), memory save (ACC-02)
//! and analysis of an image the user attached. An MCP tool still asks
//! (ACC-04), and so does the agent's wallpaper change, a persistent write of
//! the user's settings (ACC-07).
//!
//! The attached-image exemption covers the Z.AI image tool, which only a
//! Z.AI model with its vision server is offered; no recording can come from
//! one, so butler-agent unit tests pin that exemption (the tool is offered in
//! ask-first: `guided/catalog/tests.rs`; it runs in ask-first and never in
//! read-only: `guided/tools/image/tests.rs`). ACC-03 is the native-vision
//! smoke test next to them.
//!
//! Ask-first is the default of a new install; an install from before it
//! that never saved an access mode keeps full access (ACC-05).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::Duration;

use butler_e2e::e2e::gateway::{TERMINAL, tool_rows, turn_state};
use butler_e2e::e2e::scenario::{Access, Fixture, Scenario, Setup, accepted_turn_id, turn_timeout};
use butler_e2e::e2e::{HarnessError, fixtures, live, media, nonce};
use serde_json::{Value, json};

/// Waits until the turn waits for an approval or ends.
async fn settled(s: &Scenario, chat: &str, turn_id: &str) -> Result<Value, HarnessError> {
    let states: Vec<&str> = TERMINAL
        .iter()
        .copied()
        .chain(["waiting_for_form"])
        .collect();
    s.gw.wait_turn(chat, turn_id, &states, Duration::from_secs(turn_timeout()))
        .await
}

/// The turn ran to the end without asking for anything.
async fn delivered_without_asking(
    s: &Scenario,
    chat: &str,
    turn_id: &str,
) -> Result<(), HarnessError> {
    let turn = settled(s, chat, turn_id).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let requests = s.gw.approval_requests(chat).await?;
    assert!(requests.is_empty(), "approval requested: {requests:?}");
    Ok(())
}

fn data_file(s: &Scenario, relative: &str) -> String {
    std::fs::read_to_string(s.sandbox.data.join(relative)).unwrap_or_default()
}

/// ACC-01 — In ask-first, the first conversation's onboarding saves the
/// principal's answers without an approval.
#[tokio::test]
async fn acc_01_onboarding_saves_without_approval_in_ask_first() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let name = nonce();
    let s = Setup::new("ACC-01")?
        .cassette("ACC-01")
        .fixture(Fixture::FirstConversation)
        .access(Access::AskFirst)
        .placeholder("NONCE", &name)
        .start()
        .await?;
    assert_eq!(s.gw.settings().await?["access_mode"], "ask_first");
    let accepted =
        s.gw.say(
            "general",
            &format!(
                "Hi! My name is {name}, and please call me {name}. Save that, and skip all \
                 of the other onboarding questions."
            ),
        )
        .await?;
    let turn_id = accepted_turn_id(&accepted)?;
    delivered_without_asking(&s, "general", &turn_id).await?;
    let saved = data_file(&s, "personalization/onboarding.json")
        + &data_file(&s, "personalization/profile.json");
    assert!(
        saved.contains(&name),
        "onboarding answer not saved: {saved}"
    );
    s.finish().await
}

/// ACC-02 — In ask-first, asking Butler to remember something saves it
/// without an approval: the explicit memory tool runs and the fact is
/// recallable. Recall needs the local embedding model
/// (`BUTLER_E2E_EMBEDDING_ASSETS`); without it only the write is checked.
#[tokio::test]
async fn acc_02_memory_save_proceeds_without_approval_in_ask_first() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let code = nonce();
    let setup = Setup::new("ACC-02")?
        .cassette("ACC-02")
        .access(Access::AskFirst)
        .placeholder("NONCE", &code);
    let recall = fixtures::embedding_assets(&setup.sandbox.data)?;
    let s = setup.start().await?;
    let accepted =
        s.gw.say(
            "general",
            &format!(
                "Please save this as a durable explicit memory so you remember it in future \
                 conversations: my locker combination is {code}. Use your explicit memory \
                 tool, then confirm in one short sentence."
            ),
        )
        .await?;
    let turn_id = accepted_turn_id(&accepted)?;
    delivered_without_asking(&s, "general", &turn_id).await?;
    let rows = tool_rows(&s.gw.messages("general").await?, &turn_id);
    let write = rows
        .iter()
        .find(|row| {
            row.to_string().contains("update_explicit_memory") && row["state"] == "delivered"
        })
        .unwrap_or_else(|| panic!("no delivered explicit memory write: {rows:#?}"));
    let output = s.gw.operation_output(&turn_id, write).await?;
    assert!(
        !output.contains("requires_full_access"),
        "the memory write was refused: {output}"
    );
    if !recall {
        live::report(
            "ACC-02",
            "PARTIAL (recall skipped: set BUTLER_E2E_EMBEDDING_ASSETS)",
        );
        return s.finish().await;
    }
    let result = s
        .agent
        .cli_async(&[
            "cognition",
            "memory",
            "recall",
            "locker combination",
            "--json",
        ])
        .await?
        .json()?;
    assert!(
        result["data"]["results"].to_string().contains(&code),
        "saved fact not recalled: {result}"
    );
    s.finish().await
}

/// ACC-03 — Native-vision smoke test in ask-first: an image the user attached
/// reaches a vision model with the message, without an approval, and the
/// turn answers with the exact digits the image shows.
#[tokio::test]
async fn acc_03_attached_image_reaches_native_vision_in_ask_first() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("ACC-03")?
        .cassette("ACC-03")
        .access(Access::AskFirst)
        .start()
        .await?;
    // No 8: in this pixel font it reads as a 3.
    let png = media::digits_png("4721", 12);
    let upload =
        s.gw.upload("number.png", "image/png", &png, Some("general"))
            .await?;
    assert_eq!(upload.status, 201, "{}", upload.text);
    let file_id = upload.data()["file"]["file_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let accepted =
        s.gw.send_message(json!({
            "chat_id": "general",
            "text": "What number is written in the attached image? Reply with the digits only.",
            "attachments": [{"file_id": file_id}],
            "client_message_id": uuid::Uuid::new_v4().to_string(),
        }))
        .await?;
    let turn_id = accepted_turn_id(&accepted)?;
    delivered_without_asking(&s, "general", &turn_id).await?;
    let answer = s
        .gw
        .messages("general")
        .await?
        .into_iter()
        .filter(|message| message["role"] == "assistant" && message["turn_id"] == turn_id.as_str())
        .map(|message| message["text"].as_str().unwrap_or_default().to_owned())
        .collect::<String>();
    let digits: String = answer.chars().filter(char::is_ascii_digit).collect();
    assert_eq!(digits, "4721", "image not read: {answer}");
    s.finish().await
}

/// ACC-04 — In ask-first, an MCP tool still asks: the turn waits for approval
/// and the tool does not run.
#[tokio::test]
async fn acc_04_mcp_tool_asks_in_ask_first() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let token = nonce();
    let s = Setup::new("ACC-04")?
        .cassette("ACC-04")
        .access(Access::AskFirst)
        .placeholder("NONCE", &token)
        .start()
        .await?;
    let fixture = env!("CARGO_BIN_EXE_e2e-mcp-fixture");
    let added = s
        .gw
        .post(
            "/mcp-servers",
            json!({"id": "e2e", "display_name": "E2E fixture", "enabled": true, "transport": "stdio",
                   "command": fixture, "args": [],
                   "env": [{"key": "E2E_MCP_NONCE", "source": "literal", "value": token}]}),
        )
        .await?;
    assert!(added.status < 300, "add server: {}", added.text);
    let accepted =
        s.gw.say(
            "general",
            "Call the e2e_echo tool of the MCP server named e2e and tell me the token it returns.",
        )
        .await?;
    let turn_id = accepted_turn_id(&accepted)?;
    let turn = settled(&s, "general", &turn_id).await?;
    assert_eq!(turn_state(&turn), "waiting_for_form", "{turn}");
    let requests = s.gw.approval_requests("general").await?;
    let request = requests
        .iter()
        .find(|request| {
            request["source_turn_id"] == turn_id.as_str()
                && request["executable"] == "call_mcp_tool"
        })
        .unwrap_or_else(|| panic!("no approval request for the MCP call: {requests:?}"));
    // ACC-06 (#235): what the request would do, as data for the App's
    // localized sentence.
    assert_eq!(
        request["approval"],
        json!({"action_kind": "use_connector", "count": 1, "examples": [], "risk": "high",
               "targets": [{"kind": "connector", "path": "e2e/e2e_echo"}]}),
        "{request}"
    );
    let mut outputs = String::new();
    for row in tool_rows(&s.gw.messages("general").await?, &turn_id) {
        outputs.push_str(
            &s.gw
                .operation_output(&turn_id, &row)
                .await
                .unwrap_or_default(),
        );
    }
    assert!(
        !outputs.contains(&token),
        "the MCP tool ran before approval: {outputs}"
    );
    s.finish().await
}

/// ACC-05 — Existing installs (owner decision #236: saved settings are not
/// migrated). A new install asks first. An install from before ask-first
/// that never saved an access mode keeps full access after the upgrade: in
/// its settings, its conversations, the schedules the upgrade fills and new
/// schedules. A mode the user then saves is what it runs with, across a
/// restart.
#[tokio::test]
async fn acc_05_an_existing_install_keeps_full_access_until_it_saves_a_mode()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("ACC-05")?.fixture(Fixture::Empty);
    fixtures::scheduler_ran_today(&setup.sandbox.data)?;
    let mut s = setup.start().await?;
    assert_eq!(
        s.gw.settings().await?["access_mode"],
        "ask_first",
        "new install"
    );
    assert_eq!(chat_access(&s, "general").await?, "ask_first");
    let stored = schedule(&s).await?;
    assert_eq!(stored["access_mode"], "ask_first", "{stored}");
    let stored = stored["id"].as_str().unwrap().to_owned();

    // The data folder as the release before ask-first left it: no recorded
    // default, a schedule without an access mode, and no saved access mode.
    s.agent.terminate().await?;
    {
        let db = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))
            .unwrap();
        db.execute_batch(
            "DELETE FROM app_settings WHERE key='default-access-mode';
             UPDATE app_automations SET access_mode=NULL;",
        )
        .unwrap();
        let saved: Option<String> = db
            .query_row(
                "SELECT json_extract(value_json,'$.access_mode') FROM app_settings \
                 WHERE key='settings'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(None);
        assert_eq!(saved, None, "the fixture saved an access mode");
    }
    s.gw = s.agent.start_again().await?;
    assert_eq!(
        s.gw.settings().await?["access_mode"],
        "full_access",
        "upgraded"
    );
    assert_eq!(chat_access(&s, "general").await?, "full_access");
    let filled = s.gw.get(&format!("/automations/{stored}")).await?;
    assert_eq!(
        filled.data()["automation"]["access_mode"],
        "full_access",
        "{}",
        filled.text
    );
    assert_eq!(schedule(&s).await?["access_mode"], "full_access");

    s.patch_settings(json!({"access_mode": "ask_first"}), "access mode")
        .await?;
    s.restart().await?;
    assert_eq!(s.gw.settings().await?["access_mode"], "ask_first", "saved");
    assert_eq!(chat_access(&s, "general").await?, "ask_first");
    assert_eq!(schedule(&s).await?["access_mode"], "ask_first");
    let kept = s.gw.get(&format!("/automations/{stored}")).await?;
    assert_eq!(
        kept.data()["automation"]["access_mode"],
        "full_access",
        "a schedule keeps its own mode: {}",
        kept.text
    );
    s.finish().await
}

/// The access mode conversation `chat` runs with.
async fn chat_access(s: &Scenario, chat: &str) -> Result<String, HarnessError> {
    let reply = s.gw.get(&format!("/sessions/{chat}/controls")).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data()["controls"]["access_mode"]
        .as_str()
        .unwrap_or_else(|| panic!("no access mode: {}", reply.text))
        .to_owned())
}

/// Creates an hourly schedule posting into `general`, without an access mode.
async fn schedule(s: &Scenario) -> Result<Value, HarnessError> {
    let body = json!({"title": "E2E schedule", "prompt_body": "Summarize my day.",
        "target_session_id": "general", "interval_seconds": 3600});
    let reply = s.gw.post("/automations", body).await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    Ok(reply.data()["automation"].clone())
}

/// ACC-07 — In ask-first, the agent's wallpaper change asks first: the turn
/// waits for approval of `set_wallpaper`, and the wallpaper setting is
/// unchanged until the user decides.
#[tokio::test]
async fn acc_07_wallpaper_change_asks_in_ask_first() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("ACC-07")?
        .cassette("ACC-07")
        .access(Access::AskFirst)
        .start()
        .await?;
    let before = s.gw.settings().await?["wallpaper"].clone();
    let accepted =
        s.gw.say(
            "general",
            "Change my App wallpaper to the Silk live wallpaper, app-wide.",
        )
        .await?;
    let turn_id = accepted_turn_id(&accepted)?;
    let turn = settled(&s, "general", &turn_id).await?;
    assert_eq!(turn_state(&turn), "waiting_for_form", "{turn}");
    let requests = s.gw.approval_requests("general").await?;
    assert!(
        requests.iter().any(|request| {
            request["source_turn_id"] == turn_id.as_str()
                && request["executable"] == "set_wallpaper"
        }),
        "no approval request for the wallpaper change: {requests:?}"
    );
    assert_eq!(
        s.gw.settings().await?["wallpaper"],
        before,
        "the wallpaper changed before approval"
    );
    s.finish().await
}

/// ACC-07 (allow) — After Allow, the approved wallpaper change is applied
/// once. Needs the resumed turn, so its recording (ACC-07-ALLOW) waits for
/// that product gap to close.
#[tokio::test]
#[ignore = "product gap: TOOL-07-RESUME — resuming an ask-first turn after Allow is interrupted with turn_replay_conflict; the service exits and crash-loops on every restart"]
async fn acc_07_allow_applies_the_wallpaper_change() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("ACC-07-ALLOW")?
        .cassette("ACC-07-ALLOW")
        .access(Access::AskFirst)
        .start()
        .await?;
    let before = s.gw.settings().await?["wallpaper"].clone();
    let accepted =
        s.gw.say(
            "general",
            "Change my App wallpaper to the Silk live wallpaper, app-wide.",
        )
        .await?;
    let turn_id = accepted_turn_id(&accepted)?;
    let turn = settled(&s, "general", &turn_id).await?;
    assert_eq!(turn_state(&turn), "waiting_for_form", "{turn}");
    let requests = s.gw.approval_requests("general").await?;
    let request = requests
        .iter()
        .find(|request| {
            request["source_turn_id"] == turn_id.as_str()
                && request["executable"] == "set_wallpaper"
        })
        .unwrap_or_else(|| panic!("no approval request for the wallpaper change: {requests:?}"));
    assert_eq!(
        s.gw.settings().await?["wallpaper"],
        before,
        "the wallpaper changed before approval"
    );
    let reference = request["request_ref"]
        .as_str()
        .or_else(|| request["ref"].as_str())
        .unwrap_or_default()
        .to_owned();
    let allow =
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id=general"),
            json!({"scope": "once"}),
        )
        .await?;
    assert_eq!(allow.status, 202, "{}", allow.text);
    let deadline = std::time::Instant::now() + Duration::from_secs(turn_timeout());
    let mut restarts = 0;
    let applied = loop {
        if s.supervise().await? {
            restarts += 1;
        }
        let source = s.gw.settings().await?["wallpaper"]["source"].clone();
        if source["module"] == "butler.silk" || std::time::Instant::now() > deadline {
            break source;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    assert_eq!(applied["module"], "butler.silk", "not applied after Allow");
    assert_eq!(
        restarts, 0,
        "the service exited while resuming the approved turn"
    );
    s.finish().await
}
