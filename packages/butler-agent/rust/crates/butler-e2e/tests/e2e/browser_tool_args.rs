//! BROWSER-ARGS: schema-driven recovery through a local model and browser host.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    fake_servers::{ChatBehavior, FakeServer, LocalCapabilities},
    security::AdminClient,
};
use reqwest::Method;
use serde_json::{Value, json};
use std::time::Duration;

fn script() -> Vec<Value> {
    let arguments = [
        (
            "browser_open",
            json!({"url":"https://example.com/"}).to_string(),
        ),
        ("browser_observe", json!({"tab_id":"t1"}).to_string()),
        (
            "browser_observe",
            json!({"tab":"t1","region":null,"scale":null,"frame":null,"look":"NEVER"}).to_string(),
        ),
        ("browser_observe", json!("{\"tab\":\"t1\"}").to_string()),
        ("browser_observe", json!({"tab":"t9"}).to_string()),
    ];
    let mut messages: Vec<_> = arguments.into_iter().enumerate().map(|(i,(name,args))| json!({
        "role":"assistant","content":null,"tool_calls":[{"id":format!("args_{i}"),"type":"function",
        "function":{"name":name,"arguments":args}}]
    })).collect();
    messages.push(json!({"role":"assistant","content":"<|tool_call>call:browser_observe{tab:<|\"|>t1<|\"|>}<tool_call|>"}));
    messages.push(json!({"role":"assistant","content":"Finished."}));
    messages
}

pub(super) async fn run(messages: Vec<Value>) -> Result<(Vec<Value>, Vec<Value>), HarnessError> {
    let server = FakeServer::local_models(ChatBehavior {
        script: messages,
        refuse_stream: true,
        local_capabilities: LocalCapabilities {
            ollama: Some(vec!["completion".into(), "tools".into()]),
            ..Default::default()
        },
        ..Default::default()
    })
    .await?;
    let s = super::setup_local_models::with_local_server("BROWSER-ARGS", &server).await?;
    super::setup_local_models::use_local_model(&s, &server.base_url).await?;
    s.patch_settings(
        json!({"browser":{"browsing_agent":"off"}}),
        "direct browser tools",
    )
    .await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let stream = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", s.gw.base))
        .bearer_auth(&s.gw.token)
        .header("x-butler-admin", &admin.admin)
        .send()
        .await?;
    let host = tokio::spawn(serve_host(stream, admin));
    s.turn("general", "Read the page.").await?;
    let ops = tokio::time::timeout(Duration::from_secs(10), host)
        .await
        .unwrap()
        .unwrap()?;
    let requests = server
        .chat_requests()
        .into_iter()
        .filter(|r| r["stream"] != true && r["tools"].is_array())
        .collect();
    s.finish().await?;
    Ok((requests, ops))
}

fn output(request: &Value) -> Value {
    let message = request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|m| m["role"] == "tool")
        .unwrap();
    serde_json::from_str(message["content"].as_str().unwrap()).unwrap()
}

#[tokio::test]
async fn corrective_error() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (requests, _) = run(script()).await?;
    let error = output(&requests[2]);
    assert_eq!(error["ok"], false, "{error}");
    assert_eq!(error["error"]["code"], "invalid_arguments");
    assert_eq!(error["error"]["field"], "tab");
    let message = error["error"]["message"].as_str().unwrap();
    for text in [
        "required argument \"tab\"",
        "\"tab_id\" is not an argument",
        "did you mean \"tab\"",
        "{\"tab\":\"<tab>\"}",
    ] {
        assert!(message.contains(text), "missing {text}: {message}");
    }
    Ok(())
}

#[tokio::test]
async fn normalization_and_recovery() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (requests, ops) = run(script()).await?;
    let normalized = ops
        .iter()
        .find(|op| op["args"]["include_image"] == false)
        .expect("normalized observe must reach host without vision");
    assert_eq!(normalized["op"], "tab.observe");
    for key in ["region", "scale", "frame"] {
        assert!(normalized["args"].get(key).is_none(), "{normalized}");
    }
    let result = output(&requests[5]);
    let recovery = &result["output"];
    assert_eq!(recovery["reason"], "not_your_tab", "{recovery}");
    assert_eq!(recovery["your_tabs"], json!(["t1"]), "{recovery}");
    assert_eq!(
        recovery["recovery"],
        "No tab of this conversation has that id. Retry with one of your_tabs copied exactly (never shorten or retype an id), or call browser_tabs."
    );
    assert_eq!(
        ops.iter()
            .map(|op| op["op"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["tab.open", "tab.observe", "tab.observe", "tab.observe"]
    );
    let history = requests.last().unwrap()["messages"].as_array().unwrap();
    for original in script().iter().take(5) {
        let expected = &original["tool_calls"][0];
        let echoed = history
            .iter()
            .flat_map(|m| m["tool_calls"].as_array().into_iter().flatten())
            .find(|call| call["id"] == expected["id"])
            .unwrap();
        assert_eq!(
            echoed["function"]["arguments"], expected["function"]["arguments"],
            "raw arguments must stay byte-identical"
        );
    }
    Ok(())
}

async fn serve_host(
    mut stream: reqwest::Response,
    admin: AdminClient,
) -> Result<Vec<Value>, HarnessError> {
    let mut buffer = String::new();
    let mut ops = Vec::new();
    let mut observations = 0;
    let mut page = "Page text";
    loop {
        let frame = super::browser_delegation::next_frame(&mut stream, &mut buffer).await?;
        let op = frame["op"].as_str().unwrap();
        match op {
            "use.started" | "use.ended" => continue,
            "use.finished" => return Ok(ops),
            _ => (),
        }
        if op != "tab.waiting" {
            ops.push(frame.clone());
        }
        let result = match op {
            "tab.waiting" => json!({"status":"ok"}),
            "tab.open" => {
                admin.send(Method::POST, "/internal/browser-host/events", Some(json!({"tabs":[{
                    "id":"t1","owner":"conversation:general","profile":"signed_out","epoch":1,"holder":"agent","inUse":false,"url":"https://example.com/"
                }]})), &[]).await?;
                json!({"status":"ok","tab":"t1","url":"https://example.com/"})
            }
            "tab.observe" if frame["args"]["tab"] != "t1" => {
                json!({"status":"refused","reason":"not_your_tab"})
            }
            "tab.observe" => {
                observations += 1;
                json!({"status":"ok","tab":"t1","obs":format!("o{observations}"),"text":page,"url":"https://example.com/"})
            }
            "tab.prepare" if frame["args"]["steps"][0]["action"] == "back" => {
                json!({"status":"ok","tab":"t1","url":"https://example.com/","steps":[{"hit":{"role":"navigation","name":"Back"}}]})
            }
            "tab.prepare" => json!({"status":"refused","reason":"stale_ref"}),
            "tab.act" => {
                page = "Previous page";
                json!({"status":"ok","tab":"t1","completed":1,"steps":[{"status":"completed"}]})
            }
            _ => panic!("unexpected browser op {op}"),
        };
        let response = admin
            .send(
                Method::POST,
                &format!(
                    "/internal/browser-host/results/{}",
                    frame["id"].as_str().unwrap()
                ),
                Some(result),
                &[],
            )
            .await?;
        assert_eq!(response.status, 200, "{}", response.text);
    }
}

#[tokio::test]
async fn representations_and_schema_errors() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let cases = [
        (
            "browser_open",
            json!({"url":"https://example.com/","signed_in":"false","results":null}),
        ),
        (
            "browser_observe",
            json!({"args":{"tab":"t1","scale":"2.5","look":"never"}}),
        ),
        ("browser_observe", json!({"tab":"t1","look":"never"})),
        (
            "browser_act",
            json!({"tab":"t1","observation":"o2","observe":"false","steps":"[{\"action\":\"click\",\"ref\":\"f0-e1\",\"click_count\":\"2\",\"commits\":\"false\",\"value\":123,\"extra\":true}]"}),
        ),
        ("browser_observe", json!({"tab":null})),
        ("browser_observe", json!({"tab":true})),
        ("browser_observe", json!({"tab":"t1","scope":"invalid"})),
        ("browser_observe", json!({"tab":"t1","extra":true})),
        ("browser_observe", json!({"tab":"t1","region":"[1,2,3]"})),
        ("browser_observe", json!({"tab":"t1","region":[1,2,3]})),
        ("browser_observe", json!({"tab":"t1","region":[1,2,true,4]})),
        (
            "read_operation_results",
            json!({"result_ref":"x","sha256":"0".repeat(64),"work_id":null,"offset":0,"length":1}),
        ),
    ];
    let mut messages: Vec<_> = cases.iter().enumerate().map(|(i,(name,args))|json!({
        "role":"assistant","content":null,"tool_calls":[{"id":format!("validation_{i}"),"type":"function",
        "function":{"name":name,"arguments":args.to_string()}}]
    })).collect();
    messages[2]["tool_calls"][0]
        .as_object_mut()
        .unwrap()
        .remove("id");
    messages.push(json!({"role":"assistant","content":null,"tool_calls":[{"id":"extra_bridge","type":"function",
        "function":{"name":"tool_call","arguments":json!({"id":"native:browser_observe","arguments":{"tab":"t1","extra":true}}).to_string()}}]}));
    messages.push(json!({"role":"assistant","content":"Finished."}));
    let (requests, ops) = run(messages).await?;
    assert_eq!(output(&requests[8])["output"]["status"], "ok");
    let bridge_error = output(&requests[13]);
    assert_eq!(
        bridge_error["error"]["code"], "invalid_arguments",
        "{bridge_error}"
    );
    assert_eq!(bridge_error["error"]["field"], "extra", "{bridge_error}");
    assert_eq!(
        ops.iter()
            .map(|op| op["op"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "tab.open",
            "tab.observe",
            "tab.observe",
            "tab.prepare",
            "tab.observe",
            "tab.observe"
        ]
    );
    assert_eq!(ops[0]["args"]["signed_in"], false);
    assert!(ops[0]["args"].get("results").is_none());
    assert_eq!(ops[1]["args"]["scale"], 2.5);
    let step = &ops[3]["args"]["steps"][0];
    assert_eq!(step["click_count"], 2);
    assert_eq!(step["commits"], false);
    assert_eq!(
        step["value"], 123,
        "already-typed handler values stay intact"
    );
    assert_eq!(step["extra"], true);
    assert_eq!(ops[3]["args"]["observe"], false);
    // Null and boolean tabs reach the handler's ownership fence, rather than
    // becoming missing/type errors in the direct dispatcher.
    for round in [5, 6] {
        let result = output(&requests[round]);
        assert_eq!(result["output"]["reason"], "not_your_tab", "{result}");
        assert_eq!(result["output"]["your_tabs"], json!(["t1"]), "{result}");
    }
    assert_eq!(ops[4]["args"]["scope"], "invalid");
    assert_eq!(output(&requests[7])["output"]["status"], "ok");
    // All three malformed regions reach the handler's vision admission rule.
    // The JSON-in-string region is decoded even though its length is invalid.
    for round in [9, 10, 11] {
        let result = output(&requests[round]);
        assert_eq!(result["output"]["status"], "unavailable", "{result}");
        assert_eq!(result["output"]["reason"], "vision_required", "{result}");
    }
    let error = output(&requests[12]);
    assert_eq!(error["ok"], false, "{error}");
    assert_eq!(error["error"]["code"], "invalid_arguments", "{error}");
    assert_eq!(error["error"]["field"], "revision", "{error}");
    assert!(
        error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("required argument \"revision\" (integer or null) is missing"),
        "{error}"
    );
    assert!(
        output(&requests[12])["error"]["message"]
            .as_str()
            .unwrap()
            .contains("\"revision\":0")
    );
    Ok(())
}

#[tokio::test]
async fn text_arguments_and_readable_decoder_feedback() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut messages = script().into_iter().take(1).collect::<Vec<_>>();
    let call = json!({"name":"browser_observe","arguments":"{\"tab\":\"t1\",\"look\":\"never\"}"});
    messages.push(json!({"role":"assistant","content":format!("<tool_call>{call}</tool_call>")}));
    messages.push(json!({"role":"assistant","content":"<|tool_call>CALL : browser_observe{tab:}<tool_call|>"}));
    messages.push(json!({"role":"assistant","content":"Finished."}));
    let (requests, ops) = run(messages).await?;
    assert_eq!(
        ops.iter()
            .map(|op| op["op"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["tab.open", "tab.observe"]
    );
    assert_eq!(ops[1]["args"]["tab"], "t1");
    assert_eq!(ops[1]["args"]["include_image"], false);
    let feedback = requests.last().unwrap()["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "user")
        .unwrap()["content"]
        .as_str()
        .unwrap();
    assert!(feedback.contains("These tool calls were written as text and were not run: browser_observe (arguments were not one JSON object). Call the tool through the tool-call channel with one JSON object of arguments that matches its schema, or answer directly when no tool is needed."), "{feedback}");
    Ok(())
}

#[tokio::test]
async fn deferred_wrong_tab_preserves_gateway_recovery() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut messages = script().into_iter().take(1).collect::<Vec<_>>();
    for (index, (name, args)) in [
        (
            "tool_describe",
            json!({"ids":["native:browser_wait_for_user"]}),
        ),
        (
            "tool_call",
            json!({"id":"native:browser_wait_for_user","arguments":{"tab":"t9","reason":"other"}}),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        messages.push(json!({"role":"assistant","content":null,"tool_calls":[{
            "id":format!("recovery_{index}"),"type":"function","function":{"name":name,"arguments":args.to_string()}
        }]}));
    }
    messages.push(json!({"role":"assistant","content":"Finished."}));
    let (requests, ops) = run(messages).await?;
    assert_eq!(
        ops.iter()
            .map(|op| op["op"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["tab.open"]
    );
    let result = output(requests.last().unwrap());
    assert_eq!(result["output"]["reason"], "not_your_tab", "{result}");
    assert_eq!(result["output"]["your_tabs"], json!(["t1"]), "{result}");
    assert_eq!(
        result["output"]["recovery"],
        "No tab of this conversation has that id. Retry with one of your_tabs copied exactly (never shorten or retype an id), or call browser_tabs.",
        "{result}"
    );
    Ok(())
}

async fn repeated_idless_observe(text: bool) -> Result<(), HarnessError> {
    let observe = if text {
        json!({"role":"assistant","content":"<tool_call>{\"name\":\"browser_observe\",\"arguments\":{\"tab\":\"t1\",\"look\":\"never\"}}</tool_call>"})
    } else {
        json!({"role":"assistant","content":null,"tool_calls":[{"type":"function",
            "function":{"name":"browser_observe","arguments":"{\"tab\":\"t1\",\"look\":\"never\"}"}}]})
    };
    let mut messages = script().into_iter().take(1).collect::<Vec<_>>();
    messages.push(observe.clone());
    messages.push(json!({"role":"assistant","content":null,"tool_calls":[{"id":"back","type":"function",
        "function":{"name":"browser_act","arguments":json!({"tab":"t1","observation":"o1","observe":false,"steps":[{"action":"back"}]}).to_string()}}]}));
    messages.push(observe);
    messages.push(json!({"role":"assistant","content":"Finished."}));
    let (requests, ops) = run(messages).await?;
    assert_eq!(
        ops.iter()
            .map(|op| op["op"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "tab.open",
            "tab.observe",
            "tab.prepare",
            "tab.act",
            "tab.observe"
        ]
    );
    let first = output(&requests[2]);
    let second = output(&requests[4]);
    assert_eq!(first["output"]["obs"], "o1", "{first}");
    assert_eq!(second["output"]["obs"], "o2", "{second}");
    assert_eq!(
        first["output"]["untrusted_content"]["text"], "Page text",
        "{first}"
    );
    assert_eq!(
        second["output"]["untrusted_content"]["text"], "Previous page",
        "{second}"
    );
    Ok(())
}

#[tokio::test]
async fn repeated_idless_structured_observe() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    repeated_idless_observe(false).await
}

#[tokio::test]
async fn repeated_idless_text_observe() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    repeated_idless_observe(true).await
}

#[tokio::test]
async fn valid_free_form_wrappers_reach_mcp_intact() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let arguments = [
        json!({"input":{"count":"2"}}),
        json!({"echo":{"count":"2"}}),
    ];
    let calls = [
        ("tool_describe", json!({"ids":["mcp:e2e:echo"]})),
        (
            "tool_call",
            json!({"id":"mcp:e2e:echo","arguments":arguments[0]}),
        ),
        (
            "tool_call",
            json!({"id":"mcp:e2e:echo","arguments":arguments[1]}),
        ),
    ];
    let mut messages: Vec<_> = calls.into_iter().enumerate().map(|(index,(name,args))| json!({
        "role":"assistant","content":null,"tool_calls":[{"id":format!("free_form_{index}"),"type":"function",
        "function":{"name":name,"arguments":args.to_string()}}]
    })).collect();
    messages.push(json!({"role":"assistant","content":"Finished."}));
    let model = FakeServer::local_models(ChatBehavior {
        script: messages,
        refuse_stream: true,
        local_capabilities: LocalCapabilities {
            ollama: Some(vec!["completion".into(), "tools".into()]),
            ..Default::default()
        },
        ..Default::default()
    })
    .await?;
    let mcp = FakeServer::mcp_http().await?;
    let s = super::setup_local_models::with_local_server("FREE-FORM-ARGS", &model).await?;
    super::setup_local_models::use_local_model(&s, &model.base_url).await?;
    let added =
        s.gw.post(
            "/mcp-servers",
            json!({"id":"e2e","display_name":"Echo", "enabled":true,
        "transport":"http","url":format!("{}/mcp",mcp.base_url)}),
        )
        .await?;
    assert_eq!(added.status, 201, "{}", added.text);
    assert!(super::mcp::healthy(&super::mcp::probe(&s).await?));
    s.turn("general", "Echo the supplied objects.").await?;
    let received: Vec<Value> = mcp
        .seen()
        .iter()
        .filter_map(|seen| serde_json::from_str::<Value>(&seen.body).ok())
        .filter(|request| request["method"] == "tools/call")
        .map(|request| request["params"]["arguments"].clone())
        .collect();
    assert_eq!(received, arguments);
    s.finish().await
}
