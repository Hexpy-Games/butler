use butler_e2e::e2e::{HarnessError, scenario::Scenario};

pub(super) const PREAMBLE: &str = "Before pausing, I have calculated the inputs.";

pub(super) async fn assert_authority_message(
    s: &Scenario,
    completed: bool,
) -> Result<(), HarnessError> {
    let view = s.gw.get("/session-view?session_id=general").await?;
    let assistant: Vec<_> = view.data()["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .filter(|m| m["role"] == "assistant")
        .collect();
    assert_eq!(
        assistant.len(),
        1,
        "authority never ends a segment: {view:?}"
    );
    assert_eq!(
        assistant[0]["status"],
        if completed { "delivered" } else { "streaming" }
    );
    assert_eq!(
        assistant[0]["text"],
        if completed {
            "The total is 42."
        } else {
            PREAMBLE
        }
    );
    Ok(())
}

pub(super) async fn assert_segments(s: &Scenario, completed: bool) -> Result<(), HarnessError> {
    let view = s.gw.get("/session-view?session_id=general").await?;
    let messages = view.data()["messages"].as_array().expect("messages");
    let assistant: Vec<_> = messages
        .iter()
        .filter(|m| m["role"] == "assistant")
        .collect();
    assert_eq!(
        assistant.len(),
        if completed { 2 } else { 1 },
        "{messages:?}"
    );
    assert_eq!(assistant[0]["text"], PREAMBLE, "earlier text preserved");
    assert_eq!(
        assistant[0]["status"], "delivered",
        "pause freezes the segment"
    );
    if completed {
        assert_ne!(assistant[0]["id"], assistant[1]["id"]);
        assert_eq!(assistant[1]["text"], "The total is 42.");
        assert!(assistant[0]["cursor"].as_f64() < assistant[1]["cursor"].as_f64());
    }
    Ok(())
}
