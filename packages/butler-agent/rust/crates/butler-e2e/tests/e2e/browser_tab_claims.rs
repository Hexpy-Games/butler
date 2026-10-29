//! Tab claims within one model round, with host replies held at positive events.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
mod host;

use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    events::{LiveEvents, turn_event_kind},
    scenario::Setup,
    security::AdminClient,
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

const PROMPT: &str = "Update the page and read its contents.";
const GUARD: Duration = Duration::from_secs(20);

#[derive(Clone, Copy, Debug)]
pub(super) enum Mode {
    Same,
    Bridge,
    Reverse,
    Different,
    Shared,
}

#[tokio::test]
async fn same_tab_action_and_read_keep_call_order() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for mode in [Mode::Same, Mode::Bridge, Mode::Reverse] {
        run(mode).await?;
    }
    Ok(())
}

#[tokio::test]
async fn different_tabs_keep_action_and_read_parallel() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    run(Mode::Different).await
}

#[tokio::test]
async fn same_tab_shared_reads_stay_parallel() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    run(Mode::Shared).await
}

async fn run(mode: Mode) -> Result<(), HarnessError> {
    let s = Setup::new("BROWSER-TAB-CLAIMS")?
        .stub_cassette(cassette(mode)?)
        .start()
        .await?;
    let events = Arc::new(LiveEvents::subscribe(&s.gw, 0).await?);
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let host = host::Host::attach(admin, events.clone(), mode).await?;
    let served = tokio::spawn(host.serve());
    let id = s.gw.say_turn("general", PROMPT).await?;
    let turn = events
        .wait_turn(&s.gw, "general", &id, &["delivered", "failed"], GUARD)
        .await?;
    let reads = tokio::time::timeout(GUARD, served)
        .await
        .expect("host hung")
        .unwrap()?;
    assert_eq!(turn["state"], "delivered", "{turn}\n{}", s.agent.logs());
    let requests = s.provider()?.requests();
    assert_eq!(
        requests.len(),
        4,
        "one provider round for the two-call batch"
    );
    let messages = s.gw.messages("general").await?;
    assert!(
        messages.iter().any(|m| m["turn_id"] == id
            && m["role"] == "assistant"
            && m["status"] == "delivered"
            && m.to_string().contains("Done.")),
        "{messages:?}"
    );
    if matches!(mode, Mode::Same | Mode::Bridge | Mode::Reverse) {
        let snapshot = events.snapshot();
        let position = |call: &str, kind: &str| {
            snapshot
                .iter()
                .position(|e| {
                    turn_event_kind(e) == Some(kind)
                        && e["payload"]["event"]["payload"]["toolCallId"] == call
                })
                .unwrap()
        };
        assert!(
            position("batch-0", "tool.completed") < position("batch-1", "tool.started"),
            "same-tab race: batch-1 started before held batch-0 completed ({mode:?})"
        );
    }
    assert_outputs(&requests[3], mode);
    assert_eq!(
        reads,
        if matches!(mode, Mode::Shared) { 2 } else { 1 },
        "every read reaches the browser host"
    );
    eprintln!("tab-claims {mode:?}: 2 ordered outputs, {reads} host reads, final reply delivered");
    s.finish().await
}

fn assert_outputs(request: &Value, mode: Mode) {
    let outputs: Vec<_> = request["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| {
            v["type"] == "function_call_output"
                && v["call_id"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("batch-"))
        })
        .collect();
    assert_eq!(outputs.len(), 2);
    for (i, item) in outputs.iter().enumerate() {
        assert_eq!(item["call_id"], format!("batch-{i}"));
        let output: Value = serde_json::from_str(item["output"].as_str().unwrap()).unwrap();
        assert_ne!(output["ok"], false, "{output}");
        let read = matches!(mode, Mode::Shared) || (i == 0) == matches!(mode, Mode::Reverse);
        if read {
            assert_eq!(output["ok"], true, "{output}");
            let output = &output["output"];
            assert_eq!(output["ok"], true, "{output}");
            assert_eq!(output["content_has_more"], false, "{output}");
            assert_eq!(output["reader"], "butler-browser-tab", "{output}");
            let expected = if matches!(mode, Mode::Same | Mode::Bridge) {
                "Updated page"
            } else {
                "Original page"
            };
            assert!(
                output["markdown"].as_str().unwrap().contains(
                    format!("{expected} contains the full document and all its details. ")
                        .repeat(8)
                        .trim_end()
                ),
                "{output}"
            );
        } else {
            assert_eq!(output["output"]["completed"], 1, "{output}");
        }
    }
}

fn cassette(mode: Mode) -> Result<Cassette, HarnessError> {
    let template = Cassette::load("TOOL-01")?;
    let mut result = Cassette::load("TOOL-01")?;
    result.exchanges.clear();
    let act = json!({"tab":"A","observation":"obs-A","steps":[{"action":"click","ref":"e1"}]});
    let action = if matches!(mode, Mode::Bridge) {
        (
            "tool_call",
            json!({"id":"native:browser_act","arguments":act}),
        )
    } else {
        ("browser_act", act)
    };
    let read = (
        "web_read",
        json!({"tab":if matches!(mode, Mode::Different) {"B"} else {"A"}}),
    );
    let batch = match mode {
        Mode::Shared => vec![read, ("web_read", json!({"tab":"A","max_chars":2500}))],
        Mode::Reverse => vec![read, action],
        _ => vec![action, read],
    };
    let rounds = [
        vec![
            ("browser_open", json!({"url":"https://example.com/A"})),
            ("browser_open", json!({"url":"https://example.com/B"})),
        ],
        vec![("browser_observe", json!({"tab":"A"}))],
        batch,
    ];
    let mut history = Vec::new();
    for (round, calls) in rounds.iter().enumerate() {
        let mut exchange = template.exchanges[0].clone();
        exchange.request.key.user_request = PROMPT.into();
        exchange.request.key.round = history.clone();
        let items: Vec<_> = calls
            .iter()
            .enumerate()
            .map(|(i, (name, args))| {
                let id = if round == 2 {
                    format!("batch-{i}")
                } else {
                    format!("setup-{round}-{i}")
                };
                json!({"type":"function_call","id":format!("fc-{id}"),"call_id":id,
                "name":name,"arguments":args.to_string(),"status":"completed"})
            })
            .collect();
        exchange.response = super::browser_speed::response(&items);
        result.exchanges.push(exchange);
        history.extend(calls.iter().map(|_| "function_call".to_owned()));
        history.extend(calls.iter().map(|_| "function_call_output".to_owned()));
    }
    let mut done = template.exchanges[1].clone();
    done.request.key.user_request = PROMPT.into();
    done.request.key.round = history;
    done.response = super::browser_speed::response(&[json!({"type":"message","id":"msg_done",
        "role":"assistant","status":"completed","content":[{"type":"output_text","text":"Done.","annotations":[]}]})]);
    result.exchanges.push(done);
    Ok(result)
}
