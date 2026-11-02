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

pub(super) async fn assert_failed_child(
    s: &Scenario,
    child: &serde_json::Value,
) -> Result<(), HarnessError> {
    assert_eq!(child["status"], "failed", "{child}");
    assert_eq!(child["latest_turn"]["state"], "failed");
    assert!(child["active_turn"].is_null());
    let own =
        s.gw.get(&format!(
            "/session-view?session_id={}",
            child["session_id"].as_str().unwrap()
        ))
        .await?;
    assert_eq!(own.data()["status"], "failed");
    assert_eq!(own.data()["latest_turn"]["state"], "failed");
    assert!(own.data()["active_turn"].is_null());
    Ok(())
}
