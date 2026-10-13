//! Conception crosses the real parent-to-steward request boundary.
use butler_e2e::e2e::{matching, sanitize::Placeholders};
use serde_json::Value;

pub(super) fn assert_intent_carried(requests: &[Value]) {
    let request = requests
        .iter()
        .find(|request| {
            matching::key("/codex/responses", request, &Placeholders::default())
                .user_request
                .starts_with("role: steward\n")
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
    // The request block is the delivered packet. Other prompt sections may
    // quote the same stored message, so the carried Conception is counted
    // where the packet carries it.
    let packet = matching::key("/codex/responses", request, &Placeholders::default()).user_request;
    assert!(packet.starts_with("role: steward"), "{packet}");
    assert!(packet.contains(super::stub::REVISED_CHECK), "{packet}");
    assert_eq!(
        packet
            .matches("Goal: Choose the better approach for the owner's next step")
            .count(),
        1,
        "{packet}"
    );
}
