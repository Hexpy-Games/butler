//! Offered schemas follow the real gateway host attachment, on the model wire.
use butler_e2e::e2e::{
    HarnessError,
    fake_servers::{ChatBehavior, FakeServer, LocalCapabilities},
};
use serde_json::{Value, json};

fn call(index: usize, name: &str, args: &Value) -> Value {
    json!({"role":"assistant","content":null,"tool_calls":[{
        "id":format!("availability_{index}"),"type":"function",
        "function":{"name":name,"arguments":args.to_string()}
    }]})
}

fn offered(request: &Value, name: &str) -> bool {
    request["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| tool["function"]["name"] == name)
}

#[tokio::test]
async fn attached_host_offers_browser_read_and_withholds_web_read() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let script = vec![
        call(0, "browser_open", &json!({"url":"https://example.com/"})),
        call(1, "browser_observe", &json!({"tab":"t1","look":"never"})),
        call(
            2,
            "tool_describe",
            &json!({"ids":["native:browser_read","native:web_read"]}),
        ),
        call(
            3,
            "tool_search",
            &json!({"query":"browser_read","include_disabled":false}),
        ),
        json!({"role":"assistant","content":"Finished."}),
    ];
    let (requests, ops) = crate::browser_tool_args::run(script).await?;
    assert_ne!(requests.as_slice(), [] as [Value; 0]);
    for request in &requests {
        for name in [
            "web_search",
            "browser_open",
            "browser_observe",
            "browser_act",
        ] {
            assert!(offered(request, name), "{name}: {request}");
        }
        assert!(offered(request, "browser_read"), "{request}");
        assert!(!offered(request, "web_read"), "{request}");
        let reader = request["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["function"]["name"] == "browser_read")
            .unwrap();
        assert!(
            reader["function"]["parameters"]["properties"]
                .get("url")
                .is_some()
        );
        assert!(reader["function"]["parameters"].get("required").is_none());
    }
    assert_eq!(
        ops.iter()
            .map(|op| op["op"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["tab.open", "tab.observe"]
    );
    let outputs: Vec<Value> = requests.last().unwrap()["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "tool")
        .map(|message| serde_json::from_str(message["content"].as_str().unwrap()).unwrap())
        .collect();
    let described = outputs
        .iter()
        .find_map(|output| {
            output
                .pointer("/descriptions/0")
                .or_else(|| output.pointer("/output/descriptions/0"))
        })
        .expect("web_read description");
    assert_eq!(described["enabled"], true, "{described}");
    assert!(described["schema"]["properties"].get("url").is_some());
    assert!(described["schema"].get("required").is_none());
    let withheld = outputs
        .iter()
        .find_map(|o| {
            o.pointer("/descriptions/1")
                .or_else(|| o.pointer("/output/descriptions/1"))
        })
        .unwrap();
    assert_eq!(withheld["enabled"], false, "{withheld}");
    let results = outputs
        .iter()
        .find_map(|output| {
            output
                .get("results")
                .or_else(|| output.pointer("/output/results"))
        })
        .expect("tool search results");
    assert!(
        results
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "browser_read")
    );
    Ok(())
}

#[tokio::test]
async fn no_host_offers_web_read_and_web_search() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fixture = super::model::Fixture::start().await?;
    let server = FakeServer::local_models(ChatBehavior {
        script: vec![
            call(0, "web_search", &json!({"query":"published tide tables"})),
            call(
                1,
                "web_read",
                &json!({"url":"http://93.184.216.34/report","max_chunks":8,"max_chars":8000}),
            ),
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
    let s = crate::setup_local_models::with_local_server_env(
        "WEB-READ-FALLBACK",
        &server,
        &[
            ("BUTLER_BRAVE_SEARCH_API_KEY", "offline-fixture-key"),
            ("HTTP_PROXY", fixture.base.as_str()),
            ("http_proxy", fixture.base.as_str()),
            ("NO_PROXY", "127.0.0.1,localhost"),
            ("no_proxy", "127.0.0.1,localhost"),
        ],
    )
    .await?;
    crate::setup_local_models::use_local_model(&s, &server.base_url).await?;
    let path = s.sandbox.data.join("butler.config.json");
    let mut config: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    config["webSearch"] = json!({"provider":"brave","planning":{"enabled":false},"readerBackend":"lightweight","readerBackendRevision":2,
        "braveApiBase":format!("{}/search",fixture.base)});
    std::fs::write(path, serde_json::to_vec(&config)?)?;
    let (turn, _) = s
        .turn("general", "Look up http://93.184.216.34/report.")
        .await?;
    let requests: Vec<_> = server
        .chat_requests()
        .into_iter()
        .filter(|request| request["stream"] != true && request["tools"].is_array())
        .collect();
    assert_ne!(requests.as_slice(), [] as [Value; 0]);
    let outputs: Vec<Value> = requests.last().unwrap()["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "tool")
        .map(|message| serde_json::from_str(message["content"].as_str().unwrap()).unwrap())
        .map(|value: Value| value.get("output").cloned().unwrap_or(value))
        .collect();
    let search = outputs
        .iter()
        .find(|output| output.get("results").is_some())
        .expect("search result");
    assert_eq!(search["results"].as_array().unwrap().len(), 3);
    let read = outputs
        .iter()
        .find(|output| output.get("markdown").is_some())
        .expect("reader result");
    assert_eq!(read["ok"], true, "{read}");
    assert!(read["total_chunks"].as_u64().unwrap() >= 3);
    assert_eq!(read["returned_chunks"], read["total_chunks"]);
    assert_eq!(read["content_has_more"], false);
    assert!(
        read["markdown"]
            .as_str()
            .unwrap()
            .contains("End of the report.")
    );
    assert_eq!(
        fixture
            .page_fetches
            .load(std::sync::atomic::Ordering::Relaxed),
        1
    );
    assert_reader_projection(&s, &turn, read)?;
    for request in requests {
        assert!(!offered(&request, "browser_read"), "{request}");
        assert!(offered(&request, "web_read"), "{request}");
        assert!(offered(&request, "web_search"), "{request}");
    }
    s.finish().await
}

fn assert_reader_projection(
    s: &butler_e2e::e2e::scenario::Scenario,
    turn: &str,
    model: &Value,
) -> Result<(), HarnessError> {
    let db = butler_platform::sqlite::open_with_flags(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let raw: String = db.query_row("SELECT result_json FROM btcc_guided_tool_calls WHERE turn_id=?1 AND tool_name='web_read' ORDER BY rowid LIMIT 1", [turn], |row| row.get(0))?;
    let mut projected: Value = serde_json::from_str(&raw)?;
    projected["tool_name"] = json!("web_read");
    for key in [
        "evidence_receipts",
        "evidence_capability_receipts",
        "public_web_evidence_items",
    ] {
        assert!(
            projected.get(key).is_some(),
            "stored host bookkeeping lost {key}"
        );
        projected.as_object_mut().unwrap().remove(key);
    }
    for key in [
        "duration_ms",
        "effective_max_chars",
        "effective_max_chunks",
        "source_url",
        "requested_url",
    ] {
        projected.as_object_mut().unwrap().remove(key);
    }
    for (key, empty) in [
        ("warnings", json!([])),
        ("error", Value::Null),
        ("render_recommended", json!(false)),
    ] {
        if projected[key] == empty {
            projected.as_object_mut().unwrap().remove(key);
        }
    }
    for chunk in projected["chunks"].as_array_mut().unwrap() {
        chunk
            .as_object_mut()
            .unwrap()
            .retain(|key, _| matches!(key.as_str(), "id" | "index"));
    }
    assert_eq!(&projected, model, "projection changed web content");
    assert!(raw.len() < 50 * 1024);
    Ok(())
}

#[tokio::test]
async fn browser_read_url_opens_one_tab_and_continues_on_it() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    use axum::{Json, Router, routing::post};
    use butler_e2e::e2e::{scenario::Setup, security::AdminClient};
    use std::sync::{Arc, Mutex};
    let outputs = Arc::new(Mutex::new(Vec::<Value>::new()));
    let recorded = outputs.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}", listener.local_addr()?);
    let app = Router::new().route(
        "/v1/responses",
        post(move |Json(body): Json<Value>| {
            let outputs = recorded.clone();
            async move {
                let seen = super::model::outputs(&body);
                let item = if butler_e2e::e2e::chatgpt_wire::functions(&body).next().is_none() {
                    super::model::message("Finished.")
                } else {
                    *outputs.lock().unwrap() = seen.clone();
                    match seen.len() {
                    0 => super::model::call(
                        0,
                        "browser_read",
                        &json!({"url":"https://example.com/tides/alpha"}),
                    ),
                    1 => super::model::call(
                        1,
                        "browser_read",
                        &json!({"tab":seen[0]["tab"],"start_chunk":seen[0]["next_start_chunk"]}),
                    ),
                    _ => super::model::message("Finished."),
                    }
                };
                let response = crate::browser_usage::stub::response(&item);
                (
                    [("content-type", "text/event-stream")],
                    response
                        .chunks
                        .into_iter()
                        .map(|chunk| chunk.text)
                        .collect::<String>(),
                )
            }
        }),
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let s = Setup::new("BROWSER-READ-URL")?
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{base}/v1"))
        .start()
        .await?;
    s.patch_settings(
        json!({"browser":{"browsing_agent":"off"}}),
        "direct browser tools",
    )
    .await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let host = super::host::Host::attach(admin).await?;
    let frames = host.log.clone();
    let served = tokio::spawn(host.serve());
    let (_, turn) = s
        .turn("general", "Read https://example.com/tides/alpha.")
        .await?;
    served.abort();
    server.abort();
    assert_eq!(turn["state"], "delivered");
    {
        let outputs = outputs.lock().unwrap();
        assert_eq!(outputs.len(), 2, "{outputs:?}");
        let first = &outputs[0];
        assert_eq!(first["ok"], true, "{first}");
        assert_ne!(first["tab"].as_str().unwrap(), "");
        assert_ne!(first["markdown"].as_str().unwrap(), "");
        assert_eq!(first["content_has_more"], true);
        assert_eq!(outputs[1]["ok"], true, "{}", outputs[1]);
        assert_eq!(outputs[1]["tab"], first["tab"]);
        assert_eq!(outputs[1]["start_chunk"], first["next_start_chunk"]);
        let frames = frames.lock().unwrap();
        let opens: Vec<_> = frames
            .iter()
            .filter(|frame| frame["op"] == "tab.open")
            .collect();
        assert_eq!(opens.len(), 1, "{frames:?}");
        assert_eq!(opens[0]["args"]["url"], "https://example.com/tides/alpha");
        assert_eq!(
            frames
                .iter()
                .filter(|frame| frame["op"] == "tab.read")
                .count(),
            2
        );
    }
    s.finish().await
}
