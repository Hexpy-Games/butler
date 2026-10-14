//! Stub carrier replay through the real provider adapter and agent relay.
use serde_json::{Value, json};
use std::{fmt::Write as _, io::Write, process::Command};

#[test]
fn provider_tool_names_precede_every_ordered_argument_delta()
-> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let args = json!({"v":1,"blocks":[{"type":"cards","items":[{"title":"한국어"}]}]}).to_string();
    let split = args.find("한국어").ok_or("title missing")?;
    let fragments = [&args[..split], &args[split..split + 3], &args[split + 3..]];
    let cases = carriers(&args, &fragments)?;
    let path = std::path::PathBuf::from(std::env::var("BUTLER_DATA")?).join("provider-stream.json");
    std::fs::File::create(&path)?.write_all(&serde_json::to_vec(&cases)?)?;
    let output = Command::new(env!("CARGO_BIN_EXE_e2e-provider-stream"))
        .stdin(std::fs::File::open(path)?)
        .output()?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let results: Vec<Value> = serde_json::from_slice(&output.stdout)?;
    assert_eq!(results.len(), 5);
    for (i, result) in results.iter().enumerate() {
        assert_eq!(result["durableFrames"], 0);
        let events = result["relayed"].as_array().ok_or("relay missing")?;
        assert_eq!(events[0]["type"], "tool_call_start");
        assert_eq!(events[0]["toolName"], "answer_blocks");
        // The start names the same id the executed call carries.
        assert_eq!(events[0]["callId"], result["calls"][0]["id"], "case {i}");
        let actual: Vec<_> = events
            .iter()
            .skip(1)
            .map(|e| e["argumentsDelta"].as_str().unwrap())
            .collect();
        assert_eq!(
            actual,
            if i == 0 {
                fragments.to_vec()
            } else if i == 1 {
                [vec!["", ""], fragments.to_vec()].concat()
            } else {
                vec![args.as_str()]
            }
        );
        let stream = &events[0]["streamId"];
        for pair in events.windows(2) {
            assert_eq!(&pair[1]["streamId"], stream);
            assert!(pair[0]["sequence"].as_u64() < pair[1]["sequence"].as_u64());
        }
        assert_eq!(result["calls"].as_array().ok_or("calls missing")?.len(), 2);
        assert_eq!(
            result["calls"][0]["arguments"],
            serde_json::from_str::<Value>(&args)?
        );
    }
    Ok(())
}

fn carriers(args: &str, fragments: &[&str]) -> Result<Vec<Value>, serde_json::Error> {
    let input = serde_json::from_str::<Value>(args)?;
    let answer = json!({"type":"function_call","id":"item-0","call_id":"call-0","name":"answer_blocks","arguments":args});
    let other = json!({"type":"function_call","id":"item-1","call_id":"call-1","name":"read_file","arguments":"{}"});
    let mut codex =
        vec![json!({"type":"response.output_item.added","output_index":0,"item":answer})];
    codex.extend(fragments.iter().map(|delta|json!({"type":"response.function_call_arguments.delta","output_index":0,"item_id":"item-0","delta":delta})));
    codex.extend([
        json!({"type":"response.output_item.done","output_index":0,"item":answer}),
        json!({"type":"response.output_item.added","output_index":1,"item":other}),
        json!({"type":"response.function_call_arguments.delta","output_index":1,"delta":"{}"}),
        json!({"type":"response.output_item.done","output_index":1,"item":other}),
        json!({"type":"response.completed","response":{"id":"response-0","output":[answer,other]}}),
    ]);
    let mut chat = vec![
        json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-0","function":{"name":"answer_","arguments":""}}]}}]}),
        json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"blocks","arguments":""}}]}}]}),
    ];
    chat.extend(fragments.iter().map(|delta|json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":delta}}]}}]})));
    chat.push(json!({"choices":[{"finish_reason":"tool_calls","delta":{"tool_calls":[{"index":1,"id":"call-1","function":{"name":"read_file","arguments":"{}"}}]}}]}));
    let response = json!({"output":[answer,other]}).to_string();
    let anthropic = json!({"content":[{"type":"tool_use","id":"call-0","name":"answer_blocks","input":input},{"type":"tool_use","id":"call-1","name":"read_file","input":{}}]}).to_string();
    let gemini = json!({"candidates":[{"content":{"parts":[{"functionCall":{"name":"answer_blocks","args":input}},{"functionCall":{"name":"read_file","args":{}}}]}}]}).to_string();
    Ok(vec![
        json!({"provider":"openai","codex":true,"sse":true,"body":sse(&codex)}),
        json!({"provider":"qwen","chat":true,"sse":true,"body":format!("{}data: [DONE]\n\n",sse(&chat))}),
        json!({"provider":"openai","body":response}),
        json!({"provider":"anthropic","body":anthropic}),
        json!({"provider":"google","body":gemini}),
    ])
}

fn sse(events: &[Value]) -> String {
    events.iter().fold(String::new(), |mut body, event| {
        let _ = write!(body, "data: {event}\n\n");
        body
    })
}
