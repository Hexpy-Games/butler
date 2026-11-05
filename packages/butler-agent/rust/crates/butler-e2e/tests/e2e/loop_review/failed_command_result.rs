//! A run_command that exits non-zero comes back as its own result, without the
//! tool's parameter schema.
use super::common::run;
use butler_e2e::e2e::HarnessError;
use serde_json::json;

#[tokio::test]
async fn failed_command_result_has_no_schema_dump() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let args = json!({"command":"exit 1","summary":"Exit with failure","state_effect":"read_only"});
    let r = run(
        "FAILED-COMMAND-RESULT",
        vec![
            json!({"role":"assistant","content":null,"tool_calls":[{"id":"cmd_1","type":"function",
                "function":{"name":"run_command","arguments":args.to_string()}}]}),
            json!({"role":"assistant","content":"The command failed."}),
        ],
        "Run the failing command.",
    )
    .await?;
    assert!(r.requests.len() >= 2, "round 2 missing: {}", r.turn);
    let tool = r.requests[1]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rfind(|m| m["role"] == "tool")
        .unwrap()["content"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        tool.contains("\"exit_code\":1"),
        "command did not run: {tool}"
    );
    assert!(
        !tool.contains("Correct the input using this schema"),
        "failed run_command result carries the schema: {tool}"
    );
    Ok(())
}
