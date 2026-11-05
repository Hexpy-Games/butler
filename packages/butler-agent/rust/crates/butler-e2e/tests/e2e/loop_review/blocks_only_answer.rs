//! Final prose that only repeats the table answer_blocks already shows is not
//! delivered as the runtime-error text.
use super::common::run;
use butler_e2e::e2e::{HarnessError, gateway::turn_state};
use serde_json::json;

#[tokio::test]
async fn table_only_prose_is_not_runtime_error() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let spec = json!({"v":1,"blocks":[{"type":"table","id":"cmp","columns":["Item","Score"],
        "rows":[["A","1"],["B","2"]]}]});
    let r = run(
        "BLOCKS-ONLY-ANSWER",
        vec![
            json!({"role":"assistant","content":null,"tool_calls":[{"id":"blocks_1","type":"function",
                "function":{"name":"answer_blocks","arguments":spec.to_string()}}]}),
            json!({"role":"assistant","content":"| Item | Score |\n|---|---|\n| A | 1 |\n| B | 2 |"}),
        ],
        "Compare A and B in a table.",
    )
    .await?;
    let reply = r.reply.unwrap_or_default();
    assert_eq!(turn_state(&r.turn), "delivered", "{}", r.turn);
    assert_eq!(reply["answer_blocks"].as_array().map_or(0, Vec::len), 1);
    let text = reply["text"].as_str().unwrap_or_default();
    assert!(
        !text.contains("실행 중 오류가 발생해") && !text.contains("An execution error"),
        "table-only answer delivered as runtime error: {text:?}"
    );
    Ok(())
}
