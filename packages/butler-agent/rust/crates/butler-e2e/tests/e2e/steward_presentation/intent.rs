//! Conception crosses the real parent-to-steward request boundary.
use serde_json::Value;

pub(super) fn assert_intent_carried(requests: &[Value]) {
    let request = requests
        .iter()
        .find(|request| {
            request["instructions"]
                .as_str()
                .is_some_and(|text| text.contains("Steward role"))
        })
        .expect("the child ran");
    let input = request["input"].to_string();
    for expected in [
        "Goal: Choose the better approach for the owner's next step",
        "Deliver: A one-line recommendation",
        "Next: Apply the chosen approach",
        "Assumed: Both files are current",
        "are Butler's reading of the request",
        "Get the facts the goal needs",
    ] {
        assert!(input.contains(expected), "missing {expected}: {input}");
    }
    assert!(!input.contains("as unconfirmed"), "{input}");
    assert!(input.contains(super::stub::REVISED_CHECK), "{input}");
    assert_eq!(
        input
            .matches("Goal: Choose the better approach for the owner's next step")
            .count(),
        1,
        "{input}"
    );
}
