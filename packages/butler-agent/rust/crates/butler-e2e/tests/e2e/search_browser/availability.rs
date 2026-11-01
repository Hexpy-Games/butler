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
async fn attached_host_offers_browser_reading_without_web_read() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let script = vec![
        call(0, "browser_open", &json!({"url":"https://example.com/"})),
        call(1, "browser_observe", &json!({"tab":"t1","look":"never"})),
        call(2, "tool_describe", &json!({"ids":["native:web_read"]})),
        call(
            3,
            "tool_search",
            &json!({"query":"web_read","include_disabled":false}),
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
        assert!(!offered(request, "web_read"), "{request}");
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
    assert_eq!(described["enabled"], false, "{described}");
    assert_eq!(described["disabled_reason"], "browser_available");
    let results = outputs
        .iter()
        .find_map(|output| {
            output
                .get("results")
                .or_else(|| output.pointer("/output/results"))
        })
        .expect("tool search results");
    assert!(
        !results
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "web_read")
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
    assert_eq!(&projected, model, "projection changed web content");
    assert!(raw.len() < 50 * 1024);
    Ok(())
}
