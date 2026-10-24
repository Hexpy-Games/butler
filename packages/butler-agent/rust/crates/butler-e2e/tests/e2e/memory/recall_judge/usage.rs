//! The judge's model call is usage of the chat whose recall it ranks.
use super::{HarnessError, judge_count, recall, setup};
use serde_json::Value;

#[tokio::test]
async fn mem_judge_usage_counts_toward_the_recalling_chat() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = setup().await?;
    recall(&s, "accurate").await?;
    assert_eq!(judge_count(&s), 1);
    let rows: Vec<Value> =
        std::fs::read_to_string(s.sandbox.data.join("metrics/prompt-cache-usage.jsonl"))?
            .lines()
            .map(serde_json::from_str)
            .collect::<Result<_, _>>()?;
    let judge: Vec<_> = rows
        .iter()
        .filter(|r| r["phase"] == "recall_judge")
        .collect();
    assert_eq!(judge.len(), 1, "{rows:?}");
    let judge = judge[0];
    // The recall turn's own rounds name the chat; the judge must name the same one.
    let turn = rows
        .iter()
        .find(|r| r["turnId"] == judge["turnId"] && r["phase"] != "recall_judge")
        .unwrap_or_else(|| panic!("judge row lacks its turn: {judge}"));
    assert!(turn["rootSessionId"].is_string(), "{turn}");
    assert_eq!(judge["rootSessionId"], turn["rootSessionId"], "{judge}");
    assert_eq!(judge["role"], "main", "{judge}");
    let chat_rows = rows
        .iter()
        .filter(|r| r["rootSessionId"] == turn["rootSessionId"])
        .count();
    let global = s.gw.get("/usage-monitor?since_hours=24").await?;
    let listed: Vec<_> = global.data()["topSessions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["title"] == "Recall fixture")
        .collect();
    assert_eq!(listed.len(), 1, "{}", global.text);
    assert_eq!(listed[0]["requests"], chat_rows, "{}", global.text);
    s.finish().await
}
