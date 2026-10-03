use super::{get, p95, recursive, report_samples};
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

// Measure the committed activation path independently of immutable publication.
// It retains the same complete owner fixture used by the resource E2E.
pub(super) async fn run(s: &Scenario) -> Result<(), HarnessError> {
    let bundle = recursive::bundle(6);
    let mut samples = Vec::new();
    for i in 0..20 {
        let created =
            s.gw.post(
                "/sessions",
                json!({"kind":"chat","title":format!("Activation {i}")}),
            )
            .await?;
        assert_eq!(created.status, 201, "{}", created.text);
        let session = created.data()["session"]["id"].as_str().unwrap();
        let (instruction, _) = s.turn(session, "Reply with exactly the word: once").await?;
        let path = format!("/sessions/{session}/work-model");
        let request = |key: &str, command: Value| json!({"instruction_id":instruction,"idempotency_key":key,"command":command});
        let published =
            s.gw.post(
                &path,
                request("publish", json!({"op":"publish","nodes":bundle["nodes"]})),
            )
            .await?;
        assert_eq!(published.status, 200, "{}", published.text);
        assert_eq!(published.data()["ok"], true);
        assert_eq!(published.data()["active"], false);
        assert_eq!(
            published.data()["published_refs"].as_array().unwrap().len(),
            3
        );
        let input = request(
            "activate",
            json!({"op":"activate","tier":2,"goal":bundle["goal"],"root_node_id":"goal","published_refs":published.data()["published_refs"],"works":bundle["works"],"tasks":bundle["tasks"]}),
        );
        let started = Instant::now();
        let activated = s.gw.post(&path, input.clone()).await?;
        samples.push(started.elapsed());
        eprintln!("WM-13 activation sample {i}: {:?}", samples.last().unwrap());
        assert_eq!(activated.status, 200, "{}", activated.text);
        assert_eq!(activated.data()["ok"], true, "{}", activated.text);
        let view = get(s, &format!("/sessions/{session}/work-summary")).await?;
        assert_eq!(view["tier"], 2);
        assert_eq!(view["spec_count"], 3);
        assert_eq!(view["total"], 6);
        assert_eq!(view["counts"]["pending"], 6);
        assert_eq!(view["graph_revision"], 1);
        assert_eq!(view["tasks"].as_array().unwrap().len(), 6);
        assert_eq!(view["works"].as_array().unwrap().len(), 3);
        assert!(
            view["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .all(|t| t["criterion_ids"] == json!(["AC"]))
        );
        let graph = get(
            s,
            &format!("/plans/{}/task-graph", view["plan_id"].as_str().unwrap()),
        )
        .await?;
        assert_eq!(graph["tasks"], view["tasks"]);
        assert_eq!(graph["edges"].as_array().unwrap().len(), 9);
        assert_eq!(s.gw.post(&path, input).await?.data(), activated.data());
    }
    report_samples("published Spec activation", &samples);
    butler_e2e::assert_wall_clock_budget!(
        p95(samples),
        Duration::from_millis(100),
        "WM-13 activation"
    );
    Ok(())
}
