//! SS1: short Chats bubbles deliver full documents and retain title-only history.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
mod stub;
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::{Value, json};
use std::fmt::Write;

const RESEARCH: &str = "Research rainwater collection and prepare a detailed report.";
const FOLLOW: &str = "Which document did you prepare?";
const OTHER: &str = "Explain rainwater collection in this separate chat.";
const TITLE: &str = "Rainwater collection research";
fn body() -> String {
    let mut body = format!("# {TITLE}\n\n");
    for index in 1..=40 {
        writeln!(body, "## Finding {index}\nA rainwater system needs collection, filtration, storage, and maintenance. Evaluate local rainfall and roof area before sizing the tank.\n").unwrap();
    }
    body
}
fn prefix(request: &Value) -> &str {
    request["instructions"].as_str().unwrap()
}
fn request_text(request: &Value) -> String {
    request["input"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|item| item["content"].as_array().into_iter().flatten())
        .filter_map(|part| part["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

#[tokio::test]
async fn ss1_chats_rules_document_attachment_viewer_and_history() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("CHATS-REPLIES")?
        .stub_cassette(stub::cassette()?)
        .start()
        .await?;
    let (turn_id, turn) = s.turn("general", RESEARCH).await?;
    assert_eq!(turn["state"], "delivered", "{turn}\n{}", s.agent.logs());
    let requests = s.provider()?.requests();
    let stable = prefix(&requests[0]).to_owned();
    let expected = format!(
        "## Butler Role Rules\n\n{}\n\n## Chats Reply Rules\n\n{}",
        include_str!("../../../../../resources/prompts/butler.md").trim(),
        include_str!("../../../../../resources/prompts/chats.md").trim()
    );
    assert!(stable.contains(&expected), "{stable}");
    for request in &requests {
        assert_eq!(prefix(request), stable);
    }
    let messages = s.gw.messages("general").await?;
    let reply = messages
        .iter()
        .find(|m| m["role"] == "assistant" && m["turn_id"] == turn_id && m["status"] == "delivered")
        .unwrap();
    let text = reply["text"].as_str().unwrap();
    assert!(!text.contains("[document:"), "{text}");
    let sentences = text
        .split(['.', '!', '?', '。', '！', '？'])
        .filter(|s| !s.trim().is_empty())
        .count();
    assert!((1..=3).contains(&sentences), "{text}");
    let docs: Vec<_> = reply["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|a| a["kind"] == "doc" && a["deliverable"] == true)
        .collect();
    assert_eq!(docs.len(), 1, "{reply}");
    assert_eq!(docs[0]["title"], TITLE);
    let id = docs[0]["id"].as_str().unwrap();
    let opened = s.gw.get(&format!("/documents/{id}")).await?;
    assert_eq!(opened.status, 200, "{}", opened.text);
    assert_eq!(opened.data()["body"], body());
    let begin = requests.len();
    let (_, follow) = s.turn("general", FOLLOW).await?;
    assert_eq!(follow["state"], "delivered", "{follow}");
    let requests = s.provider()?.requests();
    let history = request_text(&requests[begin]);
    assert_eq!(prefix(&requests[begin]), stable);
    assert!(
        history.contains(&format!("[document:{id} \"{TITLE}\"]")),
        "{history}"
    );
    assert!(
        !history.contains("## Finding 1"),
        "document body leaked into history"
    );
    assert!(!history.contains("Evaluate local rainfall"));
    let chat =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Separate chat"}))
            .await?;
    assert_eq!(chat.status, 201, "{}", chat.text);
    let chat_id = chat.data()["session"]["id"].as_str().unwrap();
    let begin = requests.len();
    let (_, other) = s.turn(chat_id, OTHER).await?;
    assert_eq!(other["state"], "delivered", "{other}");
    for request in &s.provider()?.requests()[begin..] {
        assert!(!prefix(request).contains("Chats Reply Rules"));
    }
    eprintln!(
        "SS1: {sentences} sentences, {} document bytes, 1 attached document",
        body().len()
    );
    s.finish().await
}
