//! Stub carrier replay through the real provider adapter and agent relay.
use butler_e2e::e2e::binary::fixture_binary;
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
    let output = Command::new(fixture_binary("e2e-provider-stream")?)
        .stdin(std::fs::File::open(path)?)
        .output()?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let results: Vec<Value> = serde_json::from_slice(&output.stdout)?;
    assert_eq!(results.len(), 8);
    for (i, result) in results.iter().enumerate() {
        assert_eq!(result["durableFrames"], 0);
        assert_eq!(result["defaultToolFrames"], 0);
        assert!(
            result["events"]
                .as_array()
                .ok_or("events missing")?
                .iter()
                .all(|event| event["argumentsDelta"].is_null())
        );
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
            if matches!(i, 0 | 5 | 6) {
                fragments.to_vec()
            } else if i == 1 {
                [vec!["", ""], fragments.to_vec()].concat()
            } else {
                vec![args.as_str()]
            }
        );
        let stream = &events[0]["streamId"];
        // Native SSE cases are read as streams, not declared after the round.
        assert_eq!(
            i >= 5,
            stream.as_str().unwrap().starts_with("provider-stream-"),
            "case {i}"
        );
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
        json!({"type":"response.completed","response":{"id":"response-0","status":"completed","output":[answer,other]}}),
    ]);
    let mut chat = vec![
        json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-0","function":{"name":"answer_","arguments":""}}]}}]}),
        json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"blocks","arguments":""}}]}}]}),
    ];
    chat.extend(fragments.iter().map(|delta|json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":delta}}]}}]})));
    chat.push(json!({"choices":[{"finish_reason":"tool_calls","delta":{"tool_calls":[{"index":1,"id":"call-1","function":{"name":"read_file","arguments":"{}"}}]}}]}));
    let response = json!({"status":"completed","output":[answer,other]}).to_string();
    let anthropic = json!({"stop_reason":"tool_use","content":[{"type":"tool_use","id":"call-0","name":"answer_blocks","input":input},{"type":"tool_use","id":"call-1","name":"read_file","input":{}}]}).to_string();
    let gemini = json!({"candidates":[{"finishReason":"STOP","content":{"parts":[{"functionCall":{"name":"answer_blocks","args":input}},{"functionCall":{"name":"read_file","args":{}}}]}}]}).to_string();
    // Native streams (Anthropic Messages, Responses with an API key, Gemini SSE).
    let mut messages = vec![
        json!({"type":"message_start","message":{"id":"msg-0","type":"message","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":1}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-0","name":"answer_blocks","input":{}}}),
    ];
    messages.extend(fragments.iter().map(|delta|json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":delta}})));
    messages.extend([
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-1","name":"read_file","input":{}}}),
        json!({"type":"content_block_stop","index":1}),
        json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}),
        json!({"type":"message_stop"}),
    ]);
    // A terminal Response may leave its output to the item events.
    let responses: Vec<_> = codex
        .iter()
        .take(codex.len() - 1)
        .cloned()
        .chain([json!({"type":"response.completed","response":{"id":"response-0","status":"completed","output":[]}})])
        .collect();
    let gemini_stream = [
        json!({"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"answer_blocks","args":input}}]}}]}),
        json!({"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"read_file","args":{}}}]},"finishReason":"STOP"}]}),
    ];
    Ok(vec![
        json!({"provider":"openai","codex":true,"sse":true,"body":sse(&codex)}),
        json!({"provider":"qwen","chat":true,"sse":true,"body":format!("{}data: [DONE]\n\n",sse(&chat))}),
        json!({"provider":"openai","body":response}),
        json!({"provider":"anthropic","body":anthropic}),
        json!({"provider":"google","body":gemini}),
        json!({"provider":"anthropic","sse":true,"body":sse(&messages)}),
        json!({"provider":"openai","sse":true,"body":sse(&responses)}),
        json!({"provider":"google","sse":true,"body":sse(&gemini_stream)}),
    ])
}

fn sse(events: &[Value]) -> String {
    events.iter().fold(String::new(), |mut body, event| {
        let _ = write!(body, "data: {event}\n\n");
        body
    })
}
