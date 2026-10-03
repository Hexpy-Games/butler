use super::work_model::*;
use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Chunk, ResponseRecord},
    scenario::Setup,
};
use serde_json::{Value, json};

pub(super) fn tool_response(name: &str, args: &Value) -> ResponseRecord {
    let suffix = args["command"]["op"].as_str().unwrap_or(name);
    let item = json!({"type":"function_call","id":format!("fc_{suffix}"),"call_id":format!("call_{suffix}"),"name":name,"arguments":args.to_string(),"status":"completed"});
    let events = [
        json!({"type":"response.created","response":{"id":"resp_work","status":"in_progress","output":[]}}),
        json!({"type":"response.output_item.added","output_index":0,"item":item}),
        json!({"type":"response.function_call_arguments.done","item_id":format!("fc_{suffix}"),"output_index":0,"arguments":args.to_string()}),
        json!({"type":"response.output_item.done","output_index":0,"item":item}),
        json!({"type":"response.completed","response":{"id":"resp_work","status":"completed","model":"gpt-6-luna","output":[item],"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}),
    ];
    ResponseRecord {
        status: 200,
        headers: vec![],
        chunks: events
            .into_iter()
            .enumerate()
            .map(|(i, mut e)| {
                e["sequence_number"] = json!(i);
                Chunk {
                    delay_ms: 0,
                    text: format!("event: {}\ndata: {e}\n\n", e["type"].as_str().unwrap()),
                }
            })
            .collect(),
    }
}

pub(super) async fn direct_budget() -> Result<(), HarnessError> {
    let mut measurements = Vec::new();
    for enabled in [false, true] {
        let mut setup = Setup::new(if enabled {
            "WM-19-CORE-BUDGET"
        } else {
            "WM-19-BASE-BUDGET"
        })?
        .stub_cassette(Cassette::load("TURN-02")?);
        if enabled {
            setup = setup.env("BUTLER_WORK_MODEL", "core");
        }
        let s = setup.start().await?;
        s.turn("general", "Reply with exactly the word: once")
            .await?;
        let requests = s.provider()?.requests();
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        let bytes = request["instructions"].as_str().unwrap_or_default().len()
            + request["tools"].to_string().len();
        let schemas = request["tools"].as_array().map_or(0, Vec::len);
        let bpe = tiktoken_rs::cl100k_base().unwrap();
        let tokens = bpe
            .encode_with_special_tokens(&format!(
                "{}{}",
                request["instructions"].as_str().unwrap_or_default(),
                request["tools"]
            ))
            .len();
        measurements.push((bytes, schemas, tokens));
        s.finish().await?;
    }
    eprintln!(
        "WM-19 static system/tool bytes baseline={:?} core={:?}",
        measurements[0], measurements[1]
    );
    assert!(measurements[1].0 <= measurements[0].0);
    assert!(measurements[1].1 <= measurements[0].1);
    assert!(measurements[1].2 <= measurements[0].2);
    Ok(())
}

pub(super) async fn light_tool() -> Result<(), HarnessError> {
    let mut cassette = Cassette::load("TURN-02")?;
    let mut first = cassette.exchanges[0].clone();
    let command = light("runtime")["command"].clone();
    first.response = tool_response("work_apply", &json!({"command":command}));
    let mut last = cassette.exchanges[0].clone();
    last.request.key.round = vec!["function_call".into(), "function_call_output".into()];
    cassette.exchanges = vec![first, last];
    let s = Setup::new("WM-20-TOOL")?
        .env("BUTLER_WORK_MODEL", "core")
        .stub_cassette(cassette)
        .start()
        .await?;
    let (_, turn) = s
        .turn("general", "Reply with exactly the word: once")
        .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let view = summary(&s).await?;
    assert_eq!(view["tier"], 1, "{view}");
    assert_eq!(view["spec_count"], 1);
    assert_eq!(view["total"], 3);
    let requests = s.provider()?.requests();
    assert_eq!(requests.len(), 2, "{requests:?}");
    report_prompt("Tier1", &requests);
    let text = requests[1].to_string();
    assert!(text.contains("published_refs"), "{text}");
    assert!(!text.contains("spec_approval_required"));
    s.finish().await
}

pub(super) async fn direct_effect() -> Result<(), HarnessError> {
    let mut cassette = Cassette::load("TURN-02")?;
    let mut first = cassette.exchanges[0].clone();
    first.request.key.user_request = "Write the word once to wm.txt".into();
    first.response = tool_response("write_file", &json!({"path":"wm.txt","content":"once"}));
    let mut last = cassette.exchanges[0].clone();
    last.request.key.user_request = first.request.key.user_request.clone();
    last.request.key.round = vec!["function_call".into(), "function_call_output".into()];
    cassette.exchanges = vec![first, last];
    let s = Setup::new("WM-19-EFFECT")?
        .env("BUTLER_WORK_MODEL", "core")
        .stub_cassette(cassette)
        .start()
        .await?;
    s.turn("general", "Write the word once to wm.txt").await?;
    assert_eq!(
        std::fs::read_to_string(s.sandbox.data.join("wm.txt"))?,
        "once"
    );
    assert_eq!(summary(&s).await?["tier"], 0);
    assert_eq!(summary(&s).await?["total"], 0);
    assert_eq!(s.provider()?.served(), 2);
    s.finish().await
}

pub(super) async fn tier_floor() -> Result<(), HarnessError> {
    let mut cassette = Cassette::load("TURN-02")?;
    let template = cassette.exchanges[0].clone();
    for label in ["Delegate this direct action", "Delegate this light job"] {
        let mut first = template.clone();
        first.request.key.user_request = label.into();
        first.response = tool_response("delegate_to_steward", &json!({"request":"Delegate it"}));
        let mut last = template.clone();
        last.request.key.user_request = label.into();
        last.request.key.round = vec!["function_call".into(), "function_call_output".into()];
        cassette.exchanges.extend([first, last]);
    }
    let s = Setup::new("WM-22-FLOOR")?
        .env("BUTLER_WORK_MODEL", "core")
        .stub_cassette(cassette)
        .start()
        .await?;
    let (instruction, _) = s
        .turn("general", "Reply with exactly the word: once")
        .await?;
    s.turn("general", "Delegate this direct action").await?;
    assert_eq!(summary(&s).await?["tier"], 0);
    assert_eq!(apply(&s, light(&instruction)).await?["ok"], true);
    s.turn("general", "Delegate this light job").await?;
    let view = summary(&s).await?;
    assert_eq!(view["tier"], 1);
    assert_eq!(view["spec_count"], 1);
    assert_eq!(view["total"], 3);
    let db =
        butler_platform::sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM btcc_session_relations", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    for request in s.provider()?.requests().iter().skip(2).step_by(2) {
        assert!(request.to_string().contains("tier_two_required"));
    }
    s.finish().await
}

pub(super) async fn task_effect() -> Result<(), HarnessError> {
    let mut cassette = Cassette::load("TURN-02")?;
    let template = cassette.exchanges[0].clone();
    for label in ["Write blocked.txt", "Write ready.txt"] {
        let mut first = template.clone();
        first.request.key.user_request = label.into();
        first.response = tool_response(
            "write_file",
            &json!({"path":label.strip_prefix("Write ").unwrap(),"content":"once"}),
        );
        let mut last = template.clone();
        last.request.key.user_request = label.into();
        last.request.key.round = vec!["function_call".into(), "function_call_output".into()];
        cassette.exchanges.extend([first, last]);
    }
    let s = Setup::new("WM-TASK-EFFECT")?
        .env("BUTLER_WORK_MODEL", "core")
        .stub_cassette(cassette)
        .start()
        .await?;
    let (instruction, _) = s
        .turn("general", "Reply with exactly the word: once")
        .await?;
    assert_eq!(apply(&s, light(&instruction)).await?["ok"], true);
    s.turn("general", "Write blocked.txt").await?;
    assert!(!s.sandbox.data.join("blocked.txt").exists());
    let view = summary(&s).await?;
    let id = view["tasks"][0]["id"].clone();
    assert_eq!(apply(&s,json!({"instruction_id":instruction,"idempotency_key":"start-effect","expected_graph_revision":1,"command":{"op":"start","task_id":id,"expected_revision":1}})).await?["ok"],true);
    s.turn("general", "Write ready.txt").await?;
    assert_eq!(
        std::fs::read_to_string(s.sandbox.data.join("ready.txt"))?,
        "once"
    );
    let after = summary(&s).await?;
    assert_eq!(after["tasks"][0]["id"], id);
    assert_eq!(
        after["tasks"][0]["status"], "running",
        "Turn end fabricated Task completion"
    );
    let db =
        butler_platform::sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM btcc_guided_works", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM wm_reviews", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(db.execute("UPDATE btcc_guided_effects SET status='uncertain',result_json=NULL,receipt_json=NULL,applied_at=NULL WHERE work_id=?1",[after["tasks"][0]["work_id"].as_str().unwrap()]).unwrap(),1);
    let refused=apply(&s,json!({"instruction_id":instruction,"idempotency_key":"submit-before-reconcile","expected_graph_revision":1,"command":{"op":"submit","task_id":id,"expected_revision":2,"result_refs":["file:ready.txt"],"evidence_refs":["file:ready.txt"]}})).await?;
    assert_eq!(refused["error"]["code"], "task_effect_unsettled");
    assert_eq!(summary(&s).await?["tasks"][0]["status"], "running");
    s.finish().await
}

pub(super) fn report_prompt(label: &str, requests: &[Value]) {
    let bpe = tiktoken_rs::cl100k_base().unwrap();
    for (i, r) in requests.iter().enumerate() {
        let static_text = format!(
            "{}{}",
            r["instructions"].as_str().unwrap_or_default(),
            r["tools"]
        );
        eprintln!(
            "WM prompt {label} round={i} static_bytes={} schemas={} static_tokens={} dynamic_input_tokens={}",
            static_text.len(),
            r["tools"].as_array().map_or(0, Vec::len),
            bpe.encode_with_special_tokens(&static_text).len(),
            bpe.encode_with_special_tokens(&r["input"].to_string())
                .len()
        );
    }
}
