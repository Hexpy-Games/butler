//! Conception crosses the real parent-to-steward request boundary.
use butler_e2e::e2e::{matching, sanitize::Placeholders};
use serde_json::Value;

pub(super) fn assert_intent_carried(requests: &[Value]) {
    let request = requests
        .iter()
        .find(|request| {
            matching::key("/v1/responses", request, &Placeholders::default())
                .user_request
                .starts_with("role: steward")
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
    let packet = matching::key("/v1/responses", request, &Placeholders::default()).user_request;
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

pub(crate) fn assert_packet_stated_once(requests: &[Value]) {
    let first = requests
        .iter()
        .find(|body| super::stub::child_lane(body))
        .expect("the child ran");
    let goal_count = first["input"]
        .to_string()
        .matches("Goal: Choose the better approach for the owner's next step")
        .count();
    eprintln!("first child whole-input Goal count: {goal_count}");
    assert_child_packets_stated_once(requests);
    assert_eq!(goal_count, 1, "first child whole-input Goal count");
    for body in requests {
        let key = matching::key("/v1/responses", body, &Placeholders::default());
        if key.user_request == super::stub::OWNER {
            let input = body["input"].to_string();
            let collapsed = input.split_whitespace().collect::<Vec<_>>().join(" ");
            assert!(!collapsed.contains(
                "Original request (highest priority): Delegate reading and comparing a.txt and b.txt."
            ), "parent request repeats its own original request");
        }
    }
}

pub(crate) fn assert_child_packets_stated_once(requests: &[Value]) {
    let counts: Vec<_> = requests
        .iter()
        .filter(|body| super::stub::child_lane(body))
        .map(|body| {
            body["input"]
                .to_string()
                .matches("Plan, execute, review, and report this delegated request to Butler.")
                .count()
        })
        .collect();
    eprintln!("child whole-input packet counts: {counts:?}");
    assert!(!counts.is_empty(), "the child ran");
    assert!(
        counts.iter().all(|count| *count == 1),
        "each child input must state the packet once: {counts:?}"
    );
}
