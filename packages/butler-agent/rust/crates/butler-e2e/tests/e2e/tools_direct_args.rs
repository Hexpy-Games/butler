//! Direct calls leave catalog value constraints to their handlers.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
use butler_e2e::e2e::{
    HarnessError,
    fake_servers::{ChatBehavior, FakeServer, LocalCapabilities},
    scenario::Scenario,
};
use serde_json::{Value, json};

fn call(id: &str, name: &str, args: &Value) -> Value {
    json!({"role":"assistant","content":null,"tool_calls":[{"id":id,"type":"function",
        "function":{"name":name,"arguments":args.to_string()}}]})
}

/// A local-model chat whose model replies with `script`, in order.
async fn local(id: &str, script: Vec<Value>) -> Result<(FakeServer, Scenario), HarnessError> {
    let server = FakeServer::local_models(ChatBehavior {
        script,
        refuse_stream: true,
        local_capabilities: LocalCapabilities {
            ollama: Some(vec!["completion".into(), "tools".into()]),
            ..Default::default()
        },
        ..Default::default()
    })
    .await?;
    let s = super::setup_local_models::with_local_server(id, &server).await?;
    super::setup_local_models::use_local_model(&s, &server.base_url).await?;
    Ok((server, s))
}

/// Tool names offered by one chat-completions request.
fn offered(request: &Value) -> Vec<String> {
    request["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["function"]["name"].as_str().unwrap().to_owned())
        .collect()
}

/// The parsed tool results the last model request carried, in order.
fn tool_results(server: &FakeServer) -> Vec<Value> {
    let requests = server.chat_requests();
    requests.last().unwrap()["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "tool")
        .map(|message| serde_json::from_str(message["content"].as_str().unwrap()).unwrap())
        .collect()
}

async fn execute(name: &str, args: Value) -> Result<Value, HarnessError> {
    let (server, s) = local(
        "DIRECT-ARGS",
        vec![
            call("direct_args", name, &args),
            json!({"role":"assistant","content":"Finished."}),
        ],
    )
    .await?;
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

#[tokio::test]
async fn deferred_tool_called_by_name_runs_after_schema_feedback() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (server, s) = local(
        "BY-NAME",
        vec![
            call(
                "by_name_invalid",
                "list_automations",
                &json!({"include_deleted":"maybe"}),
            ),
            call("by_name_valid", "list_automations", &json!({})),
            json!({"role":"assistant","content":"Finished."}),
        ],
    )
    .await?;
    s.turn("general", "List my schedules.").await?;
    let first = offered(&server.chat_requests()[0]);
    assert!(first.iter().any(|name| name == "tool_call"), "{first:?}");
    assert!(
        !first.iter().any(|name| name == "list_automations"),
        "{first:?}"
    );
    let results = tool_results(&server);
    assert_eq!(results.len(), 2, "{results:?}");
    assert_eq!(
        results[0]["error"]["code"], "invalid_arguments",
        "{results:?}"
    );
    assert_eq!(
        results[0]["error"]["schema"]["properties"]["include_deleted"]["type"], "boolean",
        "{results:?}"
    );
    assert_eq!(results[1]["ok"], true, "{results:?}");
    s.finish().await?;
    Ok(())
}

#[tokio::test]
async fn deferred_tool_called_by_name_still_asks_for_approval() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (server, s) = local(
        "BY-NAME-APPROVAL",
        vec![
            call(
                "by_name_approval",
                "set_wallpaper",
                &json!({"scope":"global","source":{"kind":"live","module":"butler.silk"}}),
            ),
            json!({"role":"assistant","content":"Finished."}),
        ],
    )
    .await?;
    let reply =
        s.gw.patch(
            "/sessions/general/controls",
            json!({"access_mode":"ask_first"}),
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let before = s.gw.settings().await?;
    let id =
        s.gw.say_turn(
            "general",
            "Change my App wallpaper to the Silk live wallpaper, app-wide.",
        )
        .await?;
    let turn =
        s.gw.wait_turn(
            "general",
            &id,
            &["waiting_for_form", "delivered", "failed"],
            std::time::Duration::from_secs(30),
        )
        .await?;
    assert_eq!(turn["state"], "waiting_for_form", "{turn}");
    assert_eq!(s.gw.approval_requests("general").await?.len(), 1);
    assert_eq!(s.gw.settings().await?["wallpaper"], before["wallpaper"]);
    let first = offered(&server.chat_requests()[0]);
    assert!(
        !first.iter().any(|name| name == "set_wallpaper"),
        "{first:?}"
    );
    s.finish().await?;
    Ok(())
}
