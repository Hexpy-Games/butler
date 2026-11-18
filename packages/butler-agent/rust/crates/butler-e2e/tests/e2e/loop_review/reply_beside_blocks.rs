//! Reply text written in the same round as answer_blocks leads the delivered
//! answer, and the next round's text follows it.
use super::common::run;
use butler_e2e::e2e::{HarnessError, gateway::turn_state};
use serde_json::json;

#[tokio::test]
async fn reply_text_beside_blocks_leads_the_answer() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let lead = "Both bags fit; B is the deeper one.";
    let rest = "B still passes because the depth limit is 23 cm.";
    let spec = json!({"v":1,"blocks":[{"type":"table","id":"cmp","columns":["Bag","Depth"],
        "rows":[["A","20 cm"],["B","22 cm"]]}]});
    let r = run(
        "REPLY-BESIDE-BLOCKS",
        vec![
            json!({"role":"assistant","content":lead,"tool_calls":[{"id":"blocks_1","type":"function",
                "function":{"name":"answer_blocks","arguments":spec.to_string()}}]}),
            json!({"role":"assistant","content":rest}),
        ],
        "Do bags A and B fit the cabin depth limit? Compare them in a table.",
    )
    .await?;
    let reply = r.reply.unwrap_or_default();
    assert_eq!(turn_state(&r.turn), "delivered", "{}", r.turn);
    assert_eq!(reply["answer_blocks"].as_array().map_or(0, Vec::len), 1);
    assert_eq!(reply["text"], format!("{lead}\n\n{rest}"), "{reply}");
    assert!(r.requests.len() >= 2, "round 2 was never sent: {}", r.turn);
    let history = r.requests[1]["messages"].as_array().unwrap();
    assert!(
        history
            .iter()
            .any(|m| m["role"] == "assistant"
                && m["content"].as_str().is_some_and(|c| c.contains(lead))),
        "round 2 does not see the lead: {history:?}"
    );
    Ok(())
}
