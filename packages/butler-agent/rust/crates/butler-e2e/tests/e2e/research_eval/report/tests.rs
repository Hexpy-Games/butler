use super::*;
// test-category: pure-logic
#[test]
fn arbitrary_sets_keep_blind_reports_numeric() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut row = json!({"id":"private-task", "set":"new-holdout-set", "shape":"private-shape",
        "missed":["private-fact"], "largest_tool_outputs":["private-output"],
        "runtime_models":["private-model"], "requests":["private-request"], "unreadable":["private-url"],
        "facts_found":1, "facts_total":2, "calls":3, "input":4.0, "cached":1.0,
        "uncached":3.0, "output":2.0, "average_tools_tokens":1.0, "usd":6.0, "usd_cold":7.0});
    redact(&mut row, "new-holdout-set", 2);
    assert_eq!(row["id"], "new-holdout-set/2");
    assert!(!row.to_string().contains("private-"));
    assert!(!markdown(&[row.clone()]).contains("private-"));
    assert!(crate::research_eval::blind("new-holdout-set"));
    assert!(!crate::research_eval::blind("new-visible-set"));
    let totals = summary(&[
        row,
        json!({"set":"new-visible-set", "usd":2.0, "facts_found":1, "facts_total":1}),
        json!({"set":"new-visible-set", "usd":4.0, "facts_found":1, "facts_total":1}),
        json!({"set":"other-holdout", "usd":10.0, "facts_found":1, "facts_total":1}),
    ]);
    assert_eq!(totals["median_usd"], 5.0);
    assert_eq!(totals["median_blind_usd"], 8.0);
    assert_eq!(totals["median_usd_per_set"]["new-visible-set"], 3.0);
    assert_eq!(totals["all_facts_kept"], false);
    Ok(())
}

// test-category: pure-logic
#[tokio::test]
async fn incomplete_checkpoint_survives_and_blind_details_are_removed() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let dir = std::env::temp_dir().join(format!("research-checkpoint-{}", uuid::Uuid::new_v4()));
    let mut partial = json!({"id":"visible","set":"arbitrary","facts_found":1,"facts_total":2,
        "calls":2,"input":30,"cached":10,"uncached":20,"output":4,"usd":0.5,"usd_cold":0.6});
    outcome(
        &mut partial,
        &json!({"last_lane":"worker-0","research":"private-state"}),
        &json!({"reason":"private-reason"}),
        Some("private-error"),
    );
    write(&[partial.clone()], &dir, false).await?;
    assert!(require_complete(&[partial.clone()]).is_err());
    let first: Value = serde_json::from_slice(&tokio::fs::read(dir.join("report.json")).await?)?;
    assert_eq!(first["tasks"][0]["status"], "incomplete");
    assert_eq!(first["tasks"][0]["facts_found"], 1);
    let mut blind = partial.clone();
    redact(&mut blind, "other-holdout", 2);
    assert_eq!(
        blind,
        json!({"id":"other-holdout/2","set":"other-holdout","status":"incomplete"})
    );
    let complete = json!({"id":"next","set":"arbitrary","status":"complete","usd":1.5,"facts_found":1,"facts_total":1});
    let rows = [partial, blind, complete];
    write(&rows, &dir, false).await?;
    let saved: Value = serde_json::from_slice(&tokio::fs::read(dir.join("report.json")).await?)?;
    assert_eq!(saved["tasks"].as_array().unwrap().len(), 3);
    assert_eq!(saved["summary"]["incomplete_tasks"], 2);
    assert_eq!(saved["summary"]["median_usd"], 1.0);
    assert!(markdown(&rows).contains("| other-holdout/2 | incomplete | — | — |"));
    tokio::fs::remove_dir_all(dir).await?;
    Ok(())
}
