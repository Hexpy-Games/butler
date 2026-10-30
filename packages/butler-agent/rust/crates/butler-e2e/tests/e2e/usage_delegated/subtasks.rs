//! DELEG-USE-07/08 — session views carry exact per-type subtask totals.
use super::{ROOT, fixtures};
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::Value;

/// One usage row with explicit `(prompt, cached, output)` and optional reasoning.
fn row(
    scope: &str,
    owner: Option<(&str, &str)>,
    tokens: (u64, u64, u64),
    reasoning: Option<u64>,
) -> Value {
    let (prompt, cached, output) = tokens;
    let mut row = fixtures::row(
        scope,
        owner.map(|owner| owner.0),
        owner.map(|owner| owner.1),
        prompt,
        output,
    );
    row["cachedTokens"] = cached.into();
    if let Some(reasoning) = reasoning {
        row["reasoningTokens"] = reasoning.into();
    }
    row
}

const KEYS: [&str; 7] = [
    "requestCount",
    "promptTokens",
    "cachedTokens",
    "uncachedTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens",
];

/// `[requests, prompt, cached, uncached, output, reasoning, total]`.
fn assert_bucket(bucket: &Value, expected: [u64; 7], label: &str) {
    for (key, n) in KEYS.into_iter().zip(expected) {
        assert_eq!(
            bucket[key].as_f64(),
            Some(n as f64),
            "{label} {key}: {bucket}"
        );
    }
    assert_eq!(bucket["missingTotalTokenCount"], 0, "{label}: {bucket}");
}

fn slot_sum(view: &Value, column: usize) -> f64 {
    view["timeline"]["slots"]
        .as_array()
        .unwrap()
        .iter()
        .map(|slot| slot[column].as_f64().unwrap())
        .sum()
}

#[tokio::test]
async fn deleg_use_07_two_subtasks_exact_per_type_totals() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("DELEG-USE-07")?.start().await?;
    // Subtask B links through its BTCC relation only; A is stamped per row.
    fixtures::relations(&s.sandbox.data, &[("usage-b", ROOT, Some("steward"))])?;
    fixtures::append(
        &s.sandbox.data,
        &[
            row(ROOT, Some((ROOT, "main")), (100, 10, 20), Some(5)),
            row("usage-a", Some((ROOT, "worker")), (200, 50, 30), Some(7)),
            row("usage-a", Some((ROOT, "worker")), (300, 0, 40), None),
            row("usage-b", None, (400, 100, 60), Some(11)),
            // Another chat's subtask never counts toward this one.
            row(
                "usage-c",
                Some(("butler/app-other", "worker")),
                (900, 900, 90),
                Some(9),
            ),
        ],
    )?;
    let own = [1, 100, 10, 90, 20, 5, 120];
    let subtasks = [3, 900, 150, 750, 130, 18, 1030];
    for path in [
        "/usage-monitor?session_id=general&since_hours=24",
        "/usage-monitor?session_id=general",
    ] {
        let view = s.gw.get(path).await?;
        let model = &view.data()["model"];
        assert_bucket(&model["subtasks"], subtasks, path);
        assert_bucket(&model["byRole"]["main"], own, path);
        let total: [u64; 7] = std::array::from_fn(|i| own[i] + subtasks[i]);
        assert_bucket(model, total, path);
        // The bars' per-slot subtask columns add up to the same totals.
        if path.contains("since_hours") {
            assert_eq!(slot_sum(view.data(), 5), 1030.0, "{path}");
            assert_eq!(slot_sum(view.data(), 6), 3.0, "{path}");
            assert_eq!(slot_sum(view.data(), 7), 150.0, "{path}");
            assert_eq!(slot_sum(view.data(), 8), 130.0, "{path}");
        }
    }
    let all = s.gw.get("/usage-monitor?since_hours=24").await?;
    assert!(
        all.data()["model"]["subtasks"].is_null(),
        "all chats stay unsplit"
    );
    assert_eq!(all.data()["model"]["requestCount"], 5);
    s.finish().await
}

#[tokio::test]
async fn deleg_use_08_session_without_subtasks_reports_zero() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("DELEG-USE-08")?.start().await?;
    fixtures::append(
        &s.sandbox.data,
        &[
            row(ROOT, Some((ROOT, "main")), (100, 10, 20), None),
            row(ROOT, None, (50, 5, 10), None),
            row(
                "usage-c",
                Some(("butler/app-other", "worker")),
                (900, 900, 90),
                Some(9),
            ),
        ],
    )?;
    for path in [
        "/usage-monitor?session_id=general&since_hours=24",
        "/usage-monitor?session_id=general",
        "/usage-monitor?session_id=nobody&since_hours=24",
    ] {
        let view = s.gw.get(path).await?;
        let subtasks = &view.data()["model"]["subtasks"];
        for key in KEYS.into_iter().filter(|key| *key != "reasoningTokens") {
            assert_eq!(
                subtasks[key].as_f64(),
                Some(0.0),
                "{path} {key}: {subtasks}"
            );
        }
        assert_eq!(subtasks["missingTotalTokenCount"], 0, "{path}");
        assert!(
            subtasks.get("reasoningTokens").is_none(),
            "no reported reasoning stays absent: {subtasks}"
        );
    }
    let view =
        s.gw.get("/usage-monitor?session_id=general&since_hours=24")
            .await?;
    let model = &view.data()["model"];
    assert_eq!(model["requestCount"], 2);
    assert_eq!(model["totalTokens"], 180.0);
    assert_eq!(model["byRole"]["main"]["totalTokens"], 180.0);
    s.finish().await
}
