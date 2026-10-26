//! First-decision replies are measured, never executed by the agent.
use butler_e2e::e2e::{HarnessError, provider::delegation_eval::wire};
use serde_json::{Value, json};

pub(super) async fn verify() -> Result<(), HarnessError> {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/delegation-eval/first-decision-cases.json"
    ))?;
    let case = cases["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["id"] == "d11-papers-compare")
        .unwrap();
    let calls = [
        ("delegate_to_steward", json!({"request":case["request"]})),
        (
            "web_search",
            json!({"query":"recent speculative decoding papers"}),
        ),
        ("web_read", json!({"url":"https://example.invalid/paper"})),
        ("tool_search", json!({"query":"search research papers"})),
        ("browser_open", json!({"url":"https://example.invalid/"})),
        (
            "ask_user",
            json!({"question":"Which publication date range?"}),
        ),
    ];
    let text = json!({"type":"message","role":"assistant","content":[
        {"type":"output_text","text":"I will compare the papers."}]});
    let mut shapes = vec![vec![text.clone()]];
    let mut parallel = vec![text];
    for (index, (name, args)) in calls.iter().enumerate() {
        let mut call = wire::call(&format!("butler.{name}"), args);
        call["namespace"] = json!("butler");
        call["id"] = json!(format!("fc_shape_{index}"));
        call["call_id"] = json!(format!("call_shape_{index}"));
        shapes.push(vec![call.clone()]);
        parallel.push(call);
    }
    shapes.push(parallel);
    for final_body in [false, true] {
        for (index, output) in shapes.iter().enumerate() {
            let mut case = case.clone();
            case["first_output"] = json!(output);
            case["final_body"] = json!(final_body);
            eprintln!("FIRST_SHAPE index={index} final_body={final_body}");
            super::run::one(&case, true, None).await?;
        }
    }
    let mut long = case.clone();
    long["request"] = json!(format!(
        "{}\n{}",
        case["request"].as_str().unwrap(),
        "Compare methodology, baseline, hardware, workload, and quality in the final answer. "
            .repeat(64)
    ));
    long["first_output"] = json!(shapes.last().unwrap());
    super::run::one(&long, true, None).await
}
