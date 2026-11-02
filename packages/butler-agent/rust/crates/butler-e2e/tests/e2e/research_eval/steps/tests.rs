use super::*;
use butler_e2e::e2e::HarnessError;

fn tools() -> Vec<Value> {
    vec![
        json!({"name":"web_search","parameters":{}}),
        json!({"name":"web_read","parameters":{"properties":{"url":{},"query":{},"start_chunk":{}}}}),
    ]
}
fn receive(body: &mut Value, output: &Value) {
    let input = body["input"].as_array_mut().unwrap();
    input.push(json!({"type":"function_call_output","call_id":format!("result-{}",input.len()),"output":output.to_string()}));
}
fn arguments(items: &[Value]) -> Value {
    serde_json::from_str(items[0]["arguments"].as_str().unwrap()).unwrap()
}
fn window(text: &str, next: Option<u64>) -> Value {
    json!({"source_url":"https://example.org/page","markdown":text,"next_start_chunk":next})
}

// test-category: pure-logic
#[test]
fn fallback_is_ordered_once_then_expands_only_latest_search() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut research = Research::default();
    let mut body = json!({"input":[]});
    let plan = json!([{"search":"earlier"},{"search":"latest"},
        {"open":["https://example.org/page"]},{"read":"https://example.org/page","query":"needed"}]);
    let spec = json!({"facts":[{"page":"https://example.org/page"}]});
    let evidence = BTreeMap::new();
    let tools = tools();
    let next = |research: &mut Research, body: &Value| {
        research
            .next(&plan, body, &tools, &spec, &evidence)
            .unwrap()
    };
    assert_eq!(arguments(&next(&mut research, &body))["query"], "earlier");
    receive(
        &mut body,
        &json!({"results":[{"url":"https://example.org/old","id":"r1"}]}),
    );
    assert_eq!(arguments(&next(&mut research, &body))["query"], "latest");
    receive(
        &mut body,
        &json!({"results":[{"url":"https://example.org/page","id":"r2"},
        {"url":"https://example.org/extra","id":"r3"},{"url":"https://example.org/extra","id":"r4"}]}),
    );
    assert_eq!(arguments(&next(&mut research, &body))["query"], "needed");
    receive(&mut body, &window("ranked", Some(0)));
    assert_eq!(arguments(&next(&mut research, &body))["start_chunk"], 0);
    receive(&mut body, &window("ranked", Some(0)));
    let ordered = arguments(&next(&mut research, &body));
    assert_eq!(ordered["start_chunk"], 0);
    assert!(ordered.get("query").is_none());
    receive(&mut body, &window("first", Some(1)));
    let continuation = arguments(&next(&mut research, &body));
    assert_eq!(continuation["start_chunk"], 1);
    assert!(continuation.get("query").is_none());
    receive(&mut body, &window("last", None));
    let extra = arguments(&next(&mut research, &body));
    assert_eq!(extra["url"], "https://example.org/extra");
    assert_eq!(extra["query"], "needed");
    receive(
        &mut body,
        &json!({"source_url":"https://example.org/extra","markdown":"Other page","next_start_chunk":null}),
    );
    assert!(
        research
            .next(&plan, &body, &tools, &spec, &evidence)
            .is_none()
    );
    assert_eq!(research.reads.len(), 2);
    Ok(())
}

// test-category: pure-logic
#[test]
fn tab_only_discovery_without_browser_open_reports_unreadable() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut research = Research::default();
    let mut body = json!({"input":[]});
    let plan = json!([{"open":["https://example.org/page"]},{"read":"https://example.org/page"}]);
    let spec = json!({"facts":[{"page":"https://example.org/page"}]});
    let tools = vec![json!({"name":"tool_describe"}), json!({"name":"tool_call"})];
    let first = research
        .next(&plan, &body, &tools, &spec, &BTreeMap::new())
        .unwrap();
    assert_eq!(first[0]["name"], "tool_describe");
    let schema = json!({"properties":{"tab":{"type":"string"}},"required":["tab"]});
    receive(&mut body, &json!({"id":"native:web_read","schema":schema}));
    assert!(
        research
            .next(&plan, &body, &tools, &spec, &BTreeMap::new())
            .is_none()
    );
    assert_eq!(
        research.unreadable["https://example.org/page"]["web_read_schema"],
        schema
    );
    assert_eq!(
        research.unreadable["https://example.org/page"]["browser_open_offered"],
        false
    );
    Ok(())
}

// test-category: pure-logic
#[test]
fn first_reads_batch_and_found_facts_stop_fallback() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut research = Research::default();
    let mut body = json!({"input":[]});
    let plan = json!([{"read":"https://example.org/page"},{"read":"https://example.org/second"}]);
    let spec = json!({"facts":[{"page":"https://example.org/page"},{"page":"https://example.org/second"}]});
    let tools = tools();
    let first = research
        .next(&plan, &body, &tools, &spec, &BTreeMap::new())
        .unwrap();
    assert_eq!(first.len(), 2);
    receive(&mut body, &window("Evidence", Some(1)));
    receive(
        &mut body,
        &json!({"source_url":"https://example.org/second","markdown":"Evidence","next_start_chunk":1}),
    );
    let evidence = BTreeMap::from([(0, "Evidence".into()), (1, "Evidence".into())]);
    assert!(
        research
            .next(&plan, &body, &tools, &spec, &evidence)
            .is_none()
    );
    Ok(())
}
