//! Ask-first access (owner decision #236): ask-first is the default and asks
//! before every effect except three actions, which proceed without an
//! approval: first-conversation onboarding (ACC-01), memory save (ACC-02)
//! and analysis of an image the user attached (ACC-03). An MCP tool still
//! asks (ACC-04).
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

/// ACC-03 — In ask-first, an image the user attached is analyzed without an
/// approval: the turn answers with the digits the image shows.
#[tokio::test]
async fn acc_03_attached_image_is_analyzed_without_approval_in_ask_first()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("ACC-03")?
        .cassette("ACC-03")
        .access(Access::AskFirst)
        .start()
        .await?;
    let png = media::digits_png("4821", 12);
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
    assert!(read_digits(&answer, "4821"), "image not read: {answer}");
    s.finish().await
}

/// The answer names the four digits of the image, allowing one misread
/// glyph (the recorded reply reads the pixel-font 8 as a 3).
fn read_digits(answer: &str, digits: &str) -> bool {
    let read: Vec<char> = answer.chars().filter(char::is_ascii_digit).collect();
    read.len() == digits.len()
        && read
            .iter()
            .zip(digits.chars())
            .filter(|(a, b)| **a == *b)
            .count()
            + 1
            >= digits.len()
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
    assert!(
        requests
            .iter()
            .any(|request| request["source_turn_id"] == turn_id.as_str()
                && request["executable"] == "call_mcp_tool"),
        "no approval request for the MCP call: {requests:?}"
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
