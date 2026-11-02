//! The public child view shows the delegated request without model-only plan lines.
use super::stub;
use butler_e2e::e2e::{HarnessError, scenario::Scenario};

pub(super) async fn assert_delivered_messages(
    s: &Scenario,
    child_id: &str,
) -> Result<(), HarnessError> {
    let view =
        s.gw.get(&format!("/session-view?session_id={child_id}"))
            .await?;
    let request = view.data()["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["role"] == "user")
        .and_then(|message| message["text"].as_str())
        .unwrap()
        .to_owned();
    assert!(request.starts_with(stub::OWNER), "{request}");
    for line in ["Goal:", "Deliver:", "Next:", "Assumed:", "role: steward"] {
        assert!(!request.contains(line), "{request}");
    }
    Ok(())
}
