//! Direct calls leave catalog value constraints to their handlers.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
use butler_e2e::e2e::{
    HarnessError,
    fake_servers::{ChatBehavior, FakeServer, LocalCapabilities},
};
use serde_json::{Value, json};

async fn execute(name: &str, args: Value) -> Result<Value, HarnessError> {
    let server = FakeServer::local_models(ChatBehavior {
        script: vec![
            json!({"role":"assistant","content":null,"tool_calls":[{"id":"direct_args","type":"function",
                "function":{"name":name,"arguments":args.to_string()}}]}),
            json!({"role":"assistant","content":"Finished."}),
        ],
        refuse_stream: true,
        local_capabilities: LocalCapabilities {
            ollama: Some(vec!["completion".into(), "tools".into()]),
            ..Default::default()
        },
        ..Default::default()
    })
    .await?;
    let s = super::setup_local_models::with_local_server("DIRECT-ARGS", &server).await?;
    super::setup_local_models::use_local_model(&s, &server.base_url).await?;
    std::fs::write(s.sandbox.data.join("sample.txt"), "first\nsecond\n")?;
    s.turn(
        "general",
        "Remember to use short answers and read sample.txt.",
    )
    .await?;
    let requests = server.chat_requests();
    let result = requests
        .iter()
        .rev()
        .find_map(|request| {
            request["messages"].as_array()?.iter().rev().find_map(|m| {
                (m["role"] == "tool")
                    .then(|| serde_json::from_str::<Value>(m["content"].as_str()?).ok())
                    .flatten()
            })
        })
        .expect("handler output must reach the next model round");
    s.finish().await?;
    Ok(result)
}

#[tokio::test]
async fn out_of_range_read_reaches_clamping_handler() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let result = execute(
        "read_file",
        json!({"requests":[{"path":"sample.txt","limit_lines":1_000_000}]}),
    )
    .await?;
    assert_eq!(result["ok"], true, "{result}");
    let file = &result["output"]["files"][0];
    assert_eq!(file["ok"], true, "{result}");
    assert_eq!(file["content"], "first\nsecond\n", "{result}");
    assert_eq!(file["bytes"], 13, "{result}");
    assert_eq!(file["start_line"], 1, "{result}");
    // The handler counts the terminal newline in its inclusive end line.
    assert_eq!(file["end_line"], 3, "{result}");
    Ok(())
}

#[tokio::test]
async fn enum_alias_reaches_memory_handler() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let result = execute(
        "update_explicit_memory",
        json!({"kind":"rule","text":"Use short answers.","source":"Remember to use short answers and read sample.txt."}),
    ).await?;
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(result["output"]["ok"], true, "{result}");
    Ok(())
}

#[tokio::test]
async fn direct_repairs_only_unambiguous_representations() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let values = [
        json!("1e2"),
        json!("9007199254740993.1"),
        json!(true),
        json!("nope"),
    ];
    let mut messages = vec![json!({"role":"assistant","content":null,"tool_calls":[{
        "id":"open","type":"function","function":{"name":"browser_open",
        "arguments":json!({"url":"https://example.com/"}).to_string()}}]})];
    for (index, scale) in values.iter().enumerate() {
        messages.push(json!({"role":"assistant","content":null,"tool_calls":[{
            "id":format!("representation_{index}"),"type":"function",
            "function":{"name":"browser_observe","arguments":json!({
                "tab":"t1","scale":scale,"look":"never","args":{"tab":"t9"}
            }).to_string()}}]}));
    }
    messages.push(json!({"role":"assistant","content":"Finished."}));
    let (_, ops) = super::browser_tool_args::run(messages).await?;
    assert_eq!(ops.len(), values.len() + 1);
    assert_eq!(ops[1]["args"]["scale"].as_f64(), Some(100.0));
    for (index, original) in values.iter().enumerate().skip(1) {
        assert_eq!(ops[index + 1]["args"]["scale"], *original);
    }
    for op in ops.iter().skip(1) {
        assert_eq!(op["args"]["tab"], "t1");
        assert_eq!(op["args"]["args"], json!({"tab":"t9"}));
    }
    Ok(())
}
