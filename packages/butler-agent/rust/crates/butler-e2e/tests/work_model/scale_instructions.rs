use super::*;
use crate::instruction_sequences::instruct;

pub(super) async fn run(s: &mut Scenario) -> Result<(), HarnessError> {
    let before = get(s, "/sessions/general/work-summary").await?;
    let task = before["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["status"] == "pending")
        .unwrap();
    let id = task["id"].clone();
    let mut task_revision = task["revision"].as_u64().unwrap();
    let mut graph_revision = before["graph_revision"].as_u64().unwrap();
    let calls = s.provider()?.served();
    let mut samples = Vec::new();
    for index in 0..32 {
        let description = format!("Complete owner-scale instruction {index}");
        let input = json!({"operations":[{"op":"edit","task_id":id,
            "expected_revision":task_revision,"description":description}],
            "expected_graph_revision":graph_revision,"reason":"Bounded durable edit"});
        let began = Instant::now();
        let receipt = instruct(
            s,
            &format!("scale-instruction-{index}"),
            "steer",
            input.clone(),
        )
        .await?;
        samples.push(began.elapsed());
        assert_eq!(receipt["status"], "applied", "{receipt}");
        assert_eq!(receipt["operation_ids"].as_array().unwrap().len(), 1);
        assert_eq!(
            instruct(s, &format!("scale-instruction-{index}"), "steer", input).await?,
            receipt
        );
        task_revision += 1;
        graph_revision += 1;
        let current = get(s, "/sessions/general/work-summary").await?;
        check_summary(&current, graph_revision);
        let edited = current["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == id)
            .unwrap();
        assert_eq!(edited["revision"], task_revision);
        assert_eq!(edited["description"], description);
        assert_eq!(edited["spec_ref"], task["spec_ref"]);
    }
    report_samples("instruction admission and structured application", &samples);
    butler_e2e::assert_wall_clock_budget!(
        samples[0],
        Duration::from_millis(250),
        "WM instructions cold"
    );
    butler_e2e::assert_wall_clock_budget!(
        p95(samples[1..].to_vec()),
        Duration::from_millis(100),
        "WM instructions warm"
    );
    assert_eq!(
        s.provider()?.served(),
        calls,
        "Typed control added a model round"
    );
    let receipts = get(s, "/sessions/general/instructions").await?;
    assert_eq!(receipts["instructions"].as_array().unwrap().len(), 33);
    assert_eq!(receipts["instructions"][0]["operation_count"], 1001);
    let operations = receipts["instructions"][0]["operation_ids"]
        .as_array()
        .unwrap();
    assert_eq!(operations.len(), 1001);
    assert_eq!(operations[0], "scale-create");
    for index in 0..1000 {
        assert_eq!(operations[index + 1], format!("mutation-{index}"));
    }
    assert!(
        receipts["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["status"] == "applied")
    );
    let latest = get(s, "/sessions/general/work-summary").await?;
    summary_pages(s, graph_revision).await?;
    graph(s, before["plan_id"].as_str().unwrap(), graph_revision).await?;
    s.restart().await?;
    assert_eq!(get(s, "/sessions/general/work-summary").await?, latest);
    assert_eq!(get(s, "/sessions/general/instructions").await?, receipts);
    Ok(())
}
