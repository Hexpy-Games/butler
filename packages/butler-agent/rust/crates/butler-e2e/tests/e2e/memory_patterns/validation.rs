//! Invalid model items never consume evidence or produce malformed actions.
use super::*;
fn validate_responder(request: &Value) -> Option<ResponseRecord> {
    let t = task(request);
    let content = match t["task"].as_str() {
        Some("pattern_extraction") => {
            let events = t["events"].as_array()?;
            let ids: Vec<_> = events.iter().map(|e| e["id"].clone()).collect();
            let mut invalid = update(&Value::Null, &ids);
            invalid["window"]["start"] = json!("24:00");
            let mut all = ids.clone();
            all.extend(ids.clone());
            json!({"updates":[invalid,update(&ids[0], &ids),update(&Value::Null, &all),update(&Value::Null, &ids)]})
        }
        Some("pattern_proposal") => {
            let id = &t["patterns"][0]["id"];
            let mut invalid = candidate(id);
            invalid["action"]["schedule"]["type"] = json!("hourly");
            json!({"candidates":[invalid,candidate(id),candidate(id)]})
        }
        _ => return responder(request),
    };
    Some(title_response(&content.to_string()))
}
#[tokio::test]
async fn invalid_updates_and_duplicate_evidence_and_candidates_are_dropped()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = setup("PATTERNS-VALIDATION").await?;
    seed(&s, 0, 8)?;
    s.provider()?.set_chat_responder(validate_responder);
    enable(&s).await?;
    let store = run(&s).await?;
    assert_eq!(store["patterns"].as_array().unwrap().len(), 1);
    assert_eq!(store["patterns"][0]["evidence"]["count"], 8);
    assert_eq!(
        store["bundles"][0]["candidates"].as_array().unwrap().len(),
        1
    );
    assert_eq!(
        store["bundles"][0]["candidates"][0]["action"]["kind"],
        "schedule"
    );
    assert_eq!(
        store["bundles"][0]["candidates"][0]["action"]["deliver_to"],
        "chats"
    );
    let before = requests(&s, "pattern_extraction").len();
    run(&s).await?;
    assert_eq!(
        requests(&s, "pattern_extraction").len(),
        before,
        "unchanged history is not processed again"
    );
    s.finish().await
}

fn fail_short_page(request: &Value) -> Option<ResponseRecord> {
    let t = task(request);
    if t["task"] == "pattern_extraction" && t["events"].as_array()?.len() < 200 {
        return Some(title_response("not JSON"));
    }
    responder(request)
}
fn evidence_count(store: &Value) -> u64 {
    store["patterns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["evidence"]["count"].as_u64().unwrap())
        .sum()
}
#[tokio::test]
async fn page_failure_resumes_only_uncommitted_equal_timestamp_events() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let s = setup("PATTERNS-PAGES").await?;
    seed(&s, 0, 8)?;
    {
        let db = butler_platform::sqlite::open(
            s.sandbox.data.join("runtime/conversation-store.sqlite"),
        )?;
        for n in 8..205 {
            let id = format!("pattern-event-{n:04}");
            db.execute("INSERT INTO conversation_messages(id,session_id,seq,role,status,visibility,provenance,created_at,origin_kind) VALUES(?1,'pattern-source',?2,'user','complete','user','imported','2026-10-24T07:48:00.000Z','user_input')", rusqlite::params![id,n])?;
            db.execute("INSERT INTO conversation_parts(id,message_id,part_index,kind,content_json,status) VALUES(?1,?2,0,'text',?3,'complete')", rusqlite::params![format!("{id}-text"),id,json!({"text":"한".repeat(700)}).to_string()])?;
        }
    }
    enable(&s).await?;
    s.provider()?.set_chat_responder(fail_short_page);
    let partial = run_phase(&s, "failed").await?;
    assert_eq!(evidence_count(&partial), 200);
    assert_eq!(partial["revision"], 1);
    assert_eq!(partial["bundles"], json!([]));
    let calls = requests(&s, "pattern_extraction");
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0]["events"].as_array().unwrap().len(), 200);
    assert_eq!(calls[1]["events"].as_array().unwrap().len(), 5);
    assert_eq!(
        calls[1]["events"][0]["text"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        600
    );
    s.provider()?.set_chat_responder(responder);
    let completed = run(&s).await?;
    assert_eq!(evidence_count(&completed), 205);
    assert_eq!(completed["bundles"].as_array().unwrap().len(), 1);
    let calls = requests(&s, "pattern_extraction");
    assert_eq!(calls.len(), 3);
    assert_eq!(calls[2]["events"], calls[1]["events"]);
    assert_eq!(calls[2]["events"][0]["at_local"], "2026-10-24 Sat 07:48");
    let run_id = completed["bundles"][0]["run_id"].as_str().unwrap();
    let report: Value = serde_json::from_slice(&std::fs::read(
        s.sandbox
            .data
            .join(format!("cognition/consolidation/runs/{run_id}.json")),
    )?)?;
    let usage = report["usage"]["phases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["phase"] == "pattern_extraction")
        .unwrap();
    assert_eq!(usage["request_count"].as_f64(), Some(2.0));
    assert_eq!(usage["prompt_tokens"].as_f64(), Some(200.0));
    assert_eq!(usage["total_tokens"].as_f64(), Some(240.0));
    s.finish().await
}
