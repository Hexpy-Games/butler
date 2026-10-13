//! Public child views expose the delivered request beside unchanged framing.
use super::stub;
use butler_e2e::e2e::{HarnessError, scenario::Scenario};

pub(super) async fn assert_delivered_messages(
    s: &Scenario,
    child_id: &str,
) -> Result<(), HarnessError> {
    let view =
        s.gw.get(&format!("/session-view?session_id={child_id}"))
            .await?;
    let messages = view.data()["messages"].as_array().unwrap();
    let first = messages
        .iter()
        .find(|message| message["role"] == "user")
        .unwrap();
    let delivered = first["delivered_text"].as_str().unwrap();
    assert!(delivered.starts_with(stub::OWNER), "{delivered}");
    for intent in ["Goal:", "Deliver:", "Next:", "Assumed:"] {
        assert!(!delivered.contains(intent), "{delivered}");
    }
    assert!(
        first["text"]
            .as_str()
            .unwrap()
            .starts_with(&format!("role: steward\nrequest: {}", stub::OWNER))
    );
    for message in messages {
        if let Some(text) = message["delivered_text"].as_str() {
            for framing in [
                "role: steward",
                "Prior delegation context",
                "Continue the existing Work",
            ] {
                assert!(!text.contains(framing), "{message}");
            }
        }
    }
    let parent = s.gw.get("/session-view?session_id=general").await?;
    assert!(
        parent.data()["messages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|message| message.get("delivered_text").is_none())
    );
    Ok(())
}
