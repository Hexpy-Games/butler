//! Cache pricing boundaries and retention of observation change chains.
use super::*;

/// The purchase replay's shape (2026-10-23): a 150k-token history, 20k
/// stale tokens, 12 rounds sent, cache at 5% of the input price.
pub(super) fn assert_cache_economics() {
    use super::super::prune::worth_rewriting;
    let gemini = |rounds_sent| PruneEconomy {
        byte_limit: 2_000_000 * 2,
        cached_ratio: Some(0.05),
        rounds_sent,
    };
    assert!(!worth_rewriting(20_000, (150_000, 0), &gemini(12)));
    assert!(worth_rewriting(20_000, (150_000, 0), &gemini(200)));
    assert!(worth_rewriting(100_000, (150_000, 0), &gemini(40)));
    assert!(
        worth_rewriting(
            5_000,
            (150_000, 0),
            &PruneEconomy {
                cached_ratio: Some(1.0),
                ..gemini(1)
            }
        ),
        "without a cache discount a rewrite costs nothing extra"
    );
    let unpriced = PruneEconomy {
        cached_ratio: None,
        ..gemini(12)
    };
    assert!(!worth_rewriting(
        3_000,
        (150_000, 0),
        &PruneEconomy {
            cached_ratio: Some(1.0),
            ..gemini(1)
        }
    ));
    assert!(!worth_rewriting(20_000, (150_000, 0), &unpriced));
    assert!(worth_rewriting(
        20_000,
        (150_000, 0),
        &PruneEconomy {
            rounds_sent: 80,
            ..unpriced
        }
    ));
    let pressed = PruneEconomy {
        byte_limit: 800_000,
        ..gemini(1)
    };
    assert!(
        worth_rewriting(1, (120_000, 0), &pressed),
        "60% of the budget"
    );
    assert!(!worth_rewriting(1, (119_000, 0), &pressed));
    assert!(
        worth_rewriting(1, (1_000, 200_001), &pressed),
        "stale bytes over a quarter"
    );
}

/// Change-list observations keep their bases until a full listing arrives.
pub(super) fn assert_delta_chain() {
    let mut messages = Vec::new();
    observe(&mut messages, "a", "a1");
    for (obs, base) in [("a2", "a1"), ("a3", "a2")] {
        observe(&mut messages, "a", obs);
        let mut value: Value = serde_json::from_str(&messages.last().unwrap().content).unwrap();
        value["output"]["delta_of"] = json!(base);
        messages.last_mut().unwrap().content = value.to_string().into();
    }
    assert!(
        plan(&messages).is_empty(),
        "a chain to the newest stays whole"
    );
    observe(&mut messages, "a", "a4");
    let stale: Vec<_> = plan(&messages).into_iter().map(|s| s.index).collect();
    assert_eq!(
        stale.len(),
        3,
        "a full listing releases the chain: {stale:?}"
    );
}
