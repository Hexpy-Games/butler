//! DELEG-USE-06 — a delegating chat's own and subtask usage add up to its total.
use super::{ROOT, fixtures, stub};
use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::Setup};
use serde_json::{Value, json};
use std::{
    fs,
    time::{Duration, Instant},
};

/// Requests, input and output of the stub calls whose label passes `keep`.
fn totals(calls: &[(String, u64, u64)], keep: impl Fn(&str) -> bool) -> (u64, u64, u64) {
    calls
        .iter()
        .filter(|call| keep(&call.0))
        .fold((0, 0, 0), |(n, input, output), call| {
            (n + 1, input + call.1, output + call.2)
        })
}

/// Chat role a stub call writes; the branch summary is the chat's own work.
fn role(label: &str) -> &str {
    match label {
        "main" | "summary" => "main",
        label if label.starts_with("worker-") => "worker",
        label => label,
    }
}

fn slot_sum(view: &Value, column: usize) -> f64 {
    view["timeline"]["slots"]
        .as_array()
        .unwrap()
        .iter()
        .map(|slot| slot[column].as_f64().unwrap())
        .sum()
}

#[tokio::test]
async fn deleg_use_06_conversation_and_subtasks_add_up() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let s = Setup::new("DELEG-USE-06")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .start()
        .await?;
    s.turn("general", super::super::delegate_followup::stub::OWNER)
        .await?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let view = s.gw.get("/session-view?session_id=general").await?;
        let data = view.data();
        if data["active_turn"].is_null()
            && data["latest_turn"]["state"] == "delivered"
            && data["steward_children"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v["result"]["status"] == "success")
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "delegation did not finish: {}",
            view.text
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // A new chat from the delegated answer: its seed summary is work done for this chat.
    let answer =
        s.gw.messages("general")
            .await?
            .into_iter()
            .rev()
            .find(|message| message["role"] == "assistant" && message["status"] == "delivered")
            .expect("a settled answer");
    let branch =
        s.gw.post(
            "/space/branches",
            json!({
                "requestId": "deleg-use-06", "sourceSessionId": "general",
                "sourceMessageId": answer["id"], "title": "Follow-up",
                "destination": {"kind": "chat"},
            }),
        )
        .await?;
    assert_eq!(branch.status, 200, "{}", branch.text);
    let calls = script.calls.lock().unwrap().clone();
    for label in ["main", "summary", "steward", "worker-a", "worker-b"] {
        assert!(
            calls.iter().any(|v| v.0 == label),
            "missing {label}: {calls:?}"
        );
    }

    let rows = fs::read_to_string(s.sandbox.data.join("metrics/prompt-cache-usage.jsonl"))?;
    for row in rows
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
    {
        assert_eq!(
            row["rootSessionId"], ROOT,
            "not attributed to the chat: {row}"
        );
    }
    let (n, input, output) = totals(&calls, |_| true);
    let monitor =
        s.gw.get("/usage-monitor?session_id=general&since_hours=24")
            .await?;
    let model = &monitor.data()["model"];
    fixtures::model(model, n, input, output);
    let session = s.gw.get("/session-view?session_id=general").await?;
    fixtures::session(&session.data()["usage"], n, input, output);
    for chat_role in ["main", "steward", "worker"] {
        let (n, input, output) = totals(&calls, |label| role(label) == chat_role);
        fixtures::model(&model["byRole"][chat_role], n, input, output);
        fixtures::session(
            &session.data()["usage"]["by_role"][chat_role],
            n,
            input,
            output,
        );
    }
    // Conversation (main) plus Subtasks (every other role) is the chat total.
    let roles = model["byRole"].as_object().unwrap();
    for field in ["requestCount", "totalTokens"] {
        let sum: f64 = roles
            .values()
            .map(|part| part[field].as_f64().unwrap())
            .sum();
        assert_eq!(
            sum,
            model[field].as_f64().unwrap(),
            "byRole {field}: {model}"
        );
    }
    // Bars: slot columns 5..8 carry the subtask part of each bar.
    let (dn, din, dout) = totals(&calls, |label| role(label) != "main");
    super::super::usage_timeline::assert_timeline(monitor.data());
    assert_eq!(
        slot_sum(monitor.data(), 5),
        (din + dout) as f64,
        "subtask tokens"
    );
    assert_eq!(slot_sum(monitor.data(), 6), dn as f64, "subtask requests");
    assert_eq!(
        slot_sum(monitor.data(), 7),
        (dn * 10) as f64,
        "subtask cached"
    );
    assert_eq!(slot_sum(monitor.data(), 8), dout as f64, "subtask output");
    // Settings › Usage lists the chat once, with the same total.
    let global = s.gw.get("/usage-monitor?since_hours=24").await?;
    let listed: Vec<_> = global.data()["topSessions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["sessionId"] == "general")
        .collect();
    assert_eq!(listed.len(), 1, "{}", global.text);
    assert_eq!(
        listed[0]["totalTokens"], model["totalTokens"],
        "{}",
        global.text
    );
    assert_eq!(listed[0]["kind"], "chat");
    s.finish().await?;
    server.abort();
    Ok(())
}
