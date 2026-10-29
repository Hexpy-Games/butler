//! SS3: consolidation bundles arrive once and create schedules without authority.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
use super::memory_patterns as patterns;
use butler_e2e::e2e::{
    HarnessError, cassette::ResponseRecord, provider::title_response, scenario::Scenario,
};
use serde_json::{Value, json};
use std::time::Duration;

fn responder(request: &Value) -> Option<ResponseRecord> {
    let task = patterns::task(request);
    if task["task"] != "pattern_proposal" {
        return patterns::responder(request);
    }
    let ids: Vec<_> = if task["removed"][0]["id"].is_string() {
        vec![task["removed"][0]["id"].clone()]
    } else {
        task["patterns"]
            .as_array()?
            .iter()
            .map(|p| p["id"].clone())
            .collect()
    };
    let candidates:Vec<_> = ids.iter().map(|id| json!({"pattern_id":id,"title":"Prepare a report",
        "action":{"title":"Morning report","prompt":"Prepare the latest report.","schedule":{"type":"daily","time":"07:50"}}})).collect();
    Some(title_response(
        &json!({"candidates":candidates}).to_string(),
    ))
}
async fn messages(s: &Scenario) -> Result<Vec<Value>, HarnessError> {
    Ok(s.gw
        .messages("general")
        .await?
        .into_iter()
        .filter(|m| m["initiated"]["kind"] == "pattern_proposal")
        .collect())
}
async fn proposal(s: &Scenario) -> Result<Value, HarnessError> {
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            let rows = messages(s).await?;
            if let Some(row) = rows.first() {
                assert_eq!(rows.len(), 1);
                return Ok::<_, HarnessError>(row.clone());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("one proposal bubble")
}
mod requires_e2e_fixtures;
