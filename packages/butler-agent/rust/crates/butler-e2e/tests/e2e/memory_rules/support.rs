use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Chunk, ResponseRecord},
    scenario::Scenario,
};
use serde_json::{Value, json};
use std::path::Path;

pub(crate) fn response(item: &Value) -> ResponseRecord {
    let response_id = format!("resp_{}", item["id"].as_str().unwrap());
    let mut events = vec![
        json!({"type":"response.created","response":{"id":response_id,"status":"in_progress","output":[]}}),
        json!({"type":"response.output_item.added","output_index":0,"item":item}),
    ];
    if item["type"] == "function_call" {
        events.extend([
            json!({"type":"response.function_call_arguments.delta","item_id":item["id"],"output_index":0,"delta":item["arguments"]}),
            json!({"type":"response.function_call_arguments.done","item_id":item["id"],"output_index":0,"arguments":item["arguments"]}),
        ]);
    } else {
        events.push(json!({"type":"response.output_text.delta","item_id":item["id"],"output_index":0,"content_index":0,"delta":item["content"][0]["text"]}));
    }
    events.extend([
        json!({"type":"response.output_item.done","output_index":0,"item":item}),
        json!({"type":"response.completed","response":{"id":response_id,"object":"response","status":"completed",
            "model":"gpt-6-luna","output":[item],"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}),
    ]);
    ResponseRecord {
        status: 200,
        headers: vec![],
        chunks: events
            .into_iter()
            .enumerate()
            .map(|(i, mut event)| {
                event["sequence_number"] = json!(i);
                Chunk {
                    delay_ms: 0,
                    text: format!(
                        "event: {}\ndata: {event}\n\n",
                        event["type"].as_str().unwrap()
                    ),
                }
            })
            .collect(),
    }
}

pub(crate) fn add_call(cassette: &mut Cassette, user: &str, name: &str, args: &Value) {
    let mut call = cassette.exchanges[0].clone();
    call.request.key.user_request = user.into();
    let n = cassette.exchanges.len();
    call.response = response(
        &json!({"type":"function_call","id":format!("fc_memoryrules{n:08}"),
        "call_id":format!("call_memoryrules{n:08}"),"name":name,"status":"completed","arguments":args.to_string()}),
    );
    let mut answer = cassette.exchanges[1].clone();
    answer.request.key.user_request = user.into();
    answer.response = response(
        &json!({"type":"message","id":format!("msg_memoryrulesanswer{n:08}"),
        "role":"assistant","status":"completed","content":[{"type":"output_text","text":"Done.","annotations":[]}]}),
    );
    cassette.exchanges.extend([call, answer]);
}

pub(crate) fn meaning(request: &Value) -> ResponseRecord {
    let text = request["input"]
        .as_str()
        .or_else(|| request["input"][0]["content"][0]["text"].as_str())
        .unwrap();
    let input: Value = serde_json::from_str(text).unwrap();
    let items = if input["speaker"] == "explicit" {
        json!([
            {"kind":"preference","subject":null,"text":input["parts"][0]["text"],"evidence":[0]}
        ])
    } else {
        json!([])
    };
    let text =
        json!({"status":"processed","entities":[],"items":items,"attributes":[]}).to_string();
    response(
        &json!({"type":"message","id":"msg_rule_meaning","role":"assistant","status":"completed",
        "content":[{"type":"output_text","text":text,"annotations":[]}]}),
    )
}

pub(crate) fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

pub(crate) async fn until(mut ready: impl FnMut() -> bool) {
    tokio::time::timeout(std::time::Duration::from_secs(90), async {
        while !ready() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("production owner did not publish completion");
}

pub(crate) fn active_rules(data: &Path) -> Vec<Value> {
    read_json(&data.join("cognition/memory/rules/manifest.json")).unwrap()["scopes"]
        .as_object()
        .unwrap()
        .values()
        .flat_map(|rows| rows.as_object().unwrap().values())
        .filter(|row| row["state"] == "active")
        .cloned()
        .collect()
}

pub(crate) fn graph(data: &Path) -> std::path::PathBuf {
    let active = read_json(&data.join("cognition/memory/active-generation.json")).unwrap();
    data.join("cognition/memory/generations")
        .join(active["generation_id"].as_str().unwrap())
        .join("graph.sqlite")
}

pub(crate) async fn projection(data: &Path, rule: &Value) {
    use rusqlite::OpenFlags;
    until(|| {
        let db = butler_platform::sqlite::open_with_flags(graph(data), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let windows: Vec<(String, Option<String>)> = db.prepare("SELECT state,error_code FROM memory_projection_windows").unwrap().query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect();
        assert!(!windows.iter().any(|(_, error)| error.is_some()), "projection failed: {windows:?}");
        db.query_row("SELECT COUNT(*) FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE c.source_key=?1 AND c.current_revision=?2 AND c.status='active' AND json_extract(j.semantic_graph_state,'$.state')='complete' AND json_extract(j.hot_cache_state,'$.state')='complete'", rusqlite::params![format!("explicit_record:{}",rule["record_id"].as_str().unwrap()),rule["revision"].as_str().unwrap()], |row| row.get::<_, i64>(0)).unwrap() > 0
    }).await;
}

pub(crate) async fn tool(
    s: &Scenario,
    chat: &str,
    user: &str,
    name: &str,
) -> Result<Value, HarnessError> {
    let (id, turn) = s.turn(chat, user).await?;
    assert_eq!(
        turn["state"],
        "delivered",
        "{turn}; {:?}",
        s.provider()?.misses()
    );
    result(s, chat, &id, name).await
}

/// Delivered successes use the owner API; failures use the model-visible result.
pub(crate) async fn result(
    s: &Scenario,
    chat: &str,
    turn: &str,
    name: &str,
) -> Result<Value, HarnessError> {
    let row = tokio::time::timeout(std::time::Duration::from_secs(90), async {
        loop {
            let rows = butler_e2e::e2e::gateway::tool_rows(&s.gw.messages(chat).await?, turn);
            if let Some(row) = rows.iter().rev().find(|row| {
                row.to_string().contains(name)
                    && matches!(row["state"].as_str(), Some("delivered" | "failed"))
            }) {
                return Ok::<_, HarnessError>(row.clone());
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("tool activity did not publish its result")?;
    if row["state"] == "delivered" && row["tool_result_id"].is_string() {
        return Ok(serde_json::from_str(
            &s.gw.operation_output(turn, &row).await?,
        )?);
    }
    Ok(
        model_output(&s.provider()?.requests(), row["tool_call_id"].as_str())
            .unwrap_or_else(|| panic!("missing model-visible result for {row}")),
    )
}

pub(crate) fn model_output(requests: &[Value], call: Option<&str>) -> Option<Value> {
    requests
        .iter()
        .rev()
        .filter_map(|request| request["input"].as_array())
        .flat_map(|items| items.iter().rev())
        .filter(|item| {
            item["type"] == "function_call_output"
                && call.is_none_or(|call| item["call_id"] == call)
        })
        .find_map(|item| {
            item["output"]
                .as_str()
                .and_then(|output| serde_json::from_str(output).ok())
        })
}

pub(crate) fn typed_evidence(value: &Value) -> Vec<Value> {
    match value {
        Value::Object(row)
            if row
                .get("source_kind")
                .is_some_and(|kind| kind == "explicit_record") =>
        {
            vec![value.clone()]
        }
        Value::Object(row) => row.values().flat_map(typed_evidence).collect(),
        Value::Array(rows) => rows.iter().flat_map(typed_evidence).collect(),
        _ => vec![],
    }
}

/// Check raw rule content, never incidental digits in opaque hashes or IDs.
pub(crate) fn evidence_text(row: &Value) -> &str {
    row["excerpt"]
        .as_str()
        .expect("typed source evidence must retain its complete excerpt")
}

pub(crate) async fn new_chat(s: &Scenario, title: &str) -> Result<String, HarnessError> {
    let reply =
        s.gw.post("/sessions", json!({"kind":"chat", "title":title}))
            .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    Ok(reply.data()["session"]["id"].as_str().unwrap().to_owned())
}

pub(crate) async fn vectors(data: &Path) {
    use rusqlite::OpenFlags;
    until(|| {
        let db = butler_platform::sqlite::open_with_flags(graph(data), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        db.query_row("SELECT EXISTS(SELECT 1 FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE c.status='active' AND u.state='complete') AND NOT EXISTS(SELECT 1 FROM memory_vector_units u JOIN memory_projection_jobs j ON j.job_id=u.job_id JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id AND c.current_revision=j.revision WHERE c.status='active' AND u.state IN ('pending','running','failed'))", [], |row| row.get::<_, bool>(0)).unwrap()
    }).await;
}

/// Capture only the model-visible mandatory rules, independent of turn metadata.
pub(crate) async fn active_section(
    s: &Scenario,
    chat: &str,
    user: &str,
) -> Result<String, HarnessError> {
    let first = s.provider()?.requests().len();
    let (_, turn) = s.turn(chat, user).await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let requests = s.provider()?.requests();
    let request = requests[first..]
        .iter()
        .find(|r| r["reasoning"]["effort"] == "max")
        .unwrap();
    Ok(instruction_section(request))
}

pub(crate) fn instruction_section(request: &Value) -> String {
    let prompt = request["input"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|item| item["content"].as_array().into_iter().flatten())
        .filter_map(|part| part["text"].as_str())
        .find(|text| text.contains("## Active Rules"))
        .unwrap_or_default();
    prompt
        .split("## Active Rules")
        .nth(1)
        .and_then(|section| section.split("\n\n## ").next())
        .unwrap_or_default()
        .to_owned()
}

/// Wait for the post-restart public turn's complete vector receipt, not elapsed time.
pub(crate) async fn conversation_vectors(data: &Path, turn: &str) {
    use rusqlite::OpenFlags;
    until(|| {
        let db = butler_platform::sqlite::open_with_flags(graph(data), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        db.query_row("SELECT EXISTS(SELECT 1 FROM memory_chunks c JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id AND j.revision=c.current_revision WHERE c.source_key=?1 AND c.status='active' AND json_extract(j.semantic_graph_state,'$.state')='complete' AND json_extract(j.episode_vectors_state,'$.state')='complete' AND json_extract(j.episode_vectors_state,'$.completed_units')=json_extract(j.episode_vectors_state,'$.total_units') AND json_extract(j.episode_vectors_state,'$.total_units')>0)", [format!("conversation_turn:{turn}")], |row| row.get::<_, bool>(0)).unwrap()
    }).await;
}

/// Cover the explicit context item used by chats with prior public history.
pub(crate) fn historical(cassette: &mut Cassette) {
    let ids = regex::Regex::new(r"\b((?:resp|msg|fc|rs|call)_[A-Za-z0-9]{8,})").unwrap();
    let historical = cassette
        .exchanges
        .iter()
        .cloned()
        .map(|mut exchange| {
            exchange.request.key.round.insert(0, "user".into());
            for chunk in &mut exchange.response.chunks {
                chunk.text = ids.replace_all(&chunk.text, "${1}history").into_owned();
            }
            exchange
        })
        .collect::<Vec<_>>();
    cassette.exchanges.extend(historical);
}

/// Complete identities of retained graph records; lifecycle must change sources only.
pub(crate) fn retained_graph_rows(data: &Path) -> Vec<Vec<String>> {
    use rusqlite::OpenFlags;
    let db =
        butler_platform::sqlite::open_with_flags(graph(data), OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    [
        "SELECT id FROM memory_nodes ORDER BY id",
        "SELECT node_id||':'||source_id FROM memory_evidence ORDER BY node_id,source_id",
        "SELECT edge_id FROM edges ORDER BY edge_id",
        "SELECT edge_id||':'||chunk_source_id FROM edge_evidence ORDER BY edge_id,chunk_source_id",
    ]
    .into_iter()
    .map(|sql| {
        db.prepare(sql)
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    })
    .collect()
}
