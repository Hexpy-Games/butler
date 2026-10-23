//! Smart groups: a new conversation's first message files it next to the
//! conversations on the same subject, with an undoable notice.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, ResponseRecord},
    events::LiveEvents,
    provider::{is_title_request, smart_group_input, smart_group_response, title_response},
    scenario::{Fixture, Scenario, Setup},
};
use serde_json::{Value, json};
use std::time::Duration;

use butler_e2e::e2e::scenario::turn_timeout;

async fn start(name: &str) -> Result<(Scenario, LiveEvents), HarnessError> {
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let setup = Setup::new(name)?
        .fixture(Fixture::Empty)
        .stub_cassette(cassette);
    butler_e2e::e2e::fixtures::scheduler_ran_today(
        &setup.sandbox.data,
        butler_e2e::e2e::fixtures::FIXTURE_TIME,
    )?;
    butler_e2e::e2e::fixtures::onboarding_complete(&setup.sandbox.data)?;
    let s = setup.start().await?;
    s.provider()?.set_chat_responder(reply);
    s.provider()?.set_smart_group_responder(classify);
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    Ok((s, live))
}

/// The stub model: a title is the message's first two words, a turn reply
/// is fixed text.
fn reply(request: &Value) -> Option<ResponseRecord> {
    if !is_title_request(request) {
        return Some(title_response("Noted."));
    }
    let text = user_text(request)?;
    let message = text.strip_prefix("User message:").unwrap_or(&text);
    Some(title_response(&title_for(message)))
}

/// The stub classifier: the subject is the message's first word; it joins a
/// group, else pairs with a conversation, that names the same subject.
fn classify(request: &Value) -> Option<ResponseRecord> {
    let input = smart_group_input(request)?;
    let topic = subject(input["message"].as_str()?)?;
    let same = |candidate: &&Value| {
        candidate["topic"]
            .as_str()
            .is_some_and(|value| value.eq_ignore_ascii_case(topic))
            || candidate["title"]
                .as_str()
                .and_then(subject)
                .is_some_and(|value| value.eq_ignore_ascii_case(topic))
    };
    let candidates = input["candidates"].as_array()?;
    let pick = |kind: &str| {
        candidates
            .iter()
            .filter(|candidate| candidate["kind"] == kind)
            .find(same)
    };
    let answer = match (pick("group"), pick("conversation")) {
        (Some(group), _) => json!({"topic": topic, "action": "join_group", "target": group["id"]}),
        (None, Some(peer)) => {
            json!({"topic": topic, "action": "group_sessions", "target": peer["id"]})
        }
        (None, None) => json!({"topic": topic, "action": "none", "target": null}),
    };
    Some(smart_group_response(&answer.to_string()))
}

fn subject(text: &str) -> Option<&str> {
    text.split_whitespace().next()
}

fn title_for(message: &str) -> String {
    message
        .split_whitespace()
        .take(2)
        .collect::<Vec<_>>()
        .join(" ")
}

fn user_text(request: &Value) -> Option<String> {
    request["input"].as_array()?.iter().find_map(|item| {
        (item["role"] == "user").then(|| match &item["content"] {
            Value::String(text) => Some(text.clone()),
            Value::Array(parts) => parts
                .iter()
                .find_map(|part| part["text"].as_str().map(str::to_owned)),
            _ => None,
        })?
    })
}

/// Opens a conversation the way the App does, titled with the first line
/// of its first message, and sends that message.
async fn first_message(s: &Scenario, text: &str) -> Result<String, HarnessError> {
    let id = new_chat(s, text).await?;
    send(s, &id, text).await?;
    Ok(id)
}

async fn new_chat(s: &Scenario, title: &str) -> Result<String, HarnessError> {
    let reply =
        s.gw.post("/sessions", json!({"kind": "chat", "title": title}))
            .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    Ok(reply.data()["session"]["id"].as_str().unwrap().to_owned())
}

async fn send(s: &Scenario, id: &str, text: &str) -> Result<(), HarnessError> {
    let (_, turn) = s.turn(id, text).await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    Ok(())
}

async fn space(s: &Scenario) -> Result<Value, HarnessError> {
    let navigation = s.gw.get("/navigation").await?;
    assert_eq!(navigation.status, 200, "{}", navigation.text);
    Ok(navigation.data()["space"].clone())
}

fn revision(space: &Value) -> i64 {
    space["revision"].as_i64().unwrap_or_default()
}

fn node<'a>(space: &'a Value, key: &str) -> &'a Value {
    space["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["key"] == key)
        .unwrap_or_else(|| panic!("{key} missing: {space}"))
}

/// The keys inside `parent`, sorted.
fn members(space: &Value, parent: &str) -> Vec<String> {
    sorted(
        space["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|node| node["parentKey"] == parent)
            .map(|node| node["key"].as_str().unwrap().to_owned()),
    )
}

fn sorted(keys: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut keys: Vec<String> = keys.into_iter().collect();
    keys.sort();
    keys
}

/// Waits for a space change after `after` and returns the fresh space.
async fn changed_after(s: &Scenario, live: &LiveEvents, after: i64) -> Result<Value, HarnessError> {
    live.wait_for(Duration::from_secs(turn_timeout()), |event| {
        event["type"] == "space.changed"
            && event["payload"]["revision"]
                .as_i64()
                .is_some_and(|revision| revision > after)
    })
    .await?;
    space(s).await
}

fn requests_with_message(s: &Scenario, message: &str) -> usize {
    s.provider()
        .unwrap()
        .smart_group_requests()
        .iter()
        .filter(|request| smart_group_input(request).unwrap()["message"] == message)
        .count()
}

/// SMART-01, 02, 03 — two conversations on one subject form a smart group
/// with an undo notice; undo restores both as placed by hand; with the
/// setting off, same-subject conversations stay apart and nothing is asked.
#[tokio::test]
async fn smart_01_same_subject_groups_with_undo_and_setting_off() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, live) = start("SMART-01").await?;
    let first = first_message(&s, "여행 제주도 3박 일정 짜줘").await?;
    let second_text = "여행 부산 맛집 추천해줘";
    let second = new_chat(&s, second_text).await?;
    let before = revision(&space(&s).await?);
    send(&s, &second, second_text).await?;
    let view = changed_after(&s, &live, before).await?;
    let group = &view["groups"].as_array().unwrap()[0];
    assert_eq!(view["groups"].as_array().unwrap().len(), 1, "{view}");
    assert_eq!(group["title"], "여행");
    assert_eq!(group["origin"], "smart");
    let group_key = format!("g:{}", group["id"].as_str().unwrap());
    assert_eq!(
        members(&view, &group_key),
        sorted([format!("s:{first}"), format!("s:{second}")]),
        "{view}"
    );
    assert_eq!(node(&view, &group_key)["parentKey"], Value::Null);
    for key in [format!("s:{first}"), format!("s:{second}")] {
        assert_eq!(node(&view, &key)["manualPlacement"], false, "{view}");
    }
    let notice = &view["smartNotice"];
    assert_eq!(notice["title"], "여행", "{view}");
    let token = notice["undoToken"].as_str().expect("undo token").to_owned();
    for request in s.provider()?.smart_group_requests() {
        let offered = smart_group_input(&request).unwrap();
        let raw = offered.to_string();
        assert!(!raw.contains(&first) && !raw.contains(&second), "{raw}");
    }

    let undone =
        s.gw.post(
            "/space/undo",
            json!({"expectedRevision": revision(&view), "undoToken": token}),
        )
        .await?;
    assert_eq!(undone.status, 200, "{}", undone.text);
    let view = space(&s).await?;
    assert!(view["groups"].as_array().unwrap().is_empty(), "{view}");
    assert!(view.get("smartNotice").is_none(), "{view}");
    for key in [format!("s:{first}"), format!("s:{second}")] {
        assert_eq!(node(&view, &key)["parentKey"], Value::Null, "{view}");
        assert_eq!(node(&view, &key)["manualPlacement"], true, "{view}");
    }

    let off =
        s.gw.patch("/settings", json!({"smart_grouping_enabled": false}))
            .await?;
    assert_eq!(off.status, 200, "{}", off.text);
    let asked = s.provider()?.smart_group_requests().len();
    let third = first_message(&s, "Cooking pasta sauce basics").await?;
    let fourth = first_message(&s, "Cooking pasta for kids").await?;
    let view = space(&s).await?;
    assert!(view["groups"].as_array().unwrap().is_empty(), "{view}");
    for key in [format!("s:{third}"), format!("s:{fourth}")] {
        assert_eq!(node(&view, &key)["parentKey"], Value::Null, "{view}");
    }
    assert_eq!(s.provider()?.smart_group_requests().len(), asked);
    s.finish().await
}

/// SMART-04 — a conversation placed by hand before its first message is
/// never classified, moved or offered as a peer.
#[tokio::test]
async fn smart_04_hand_placed_conversation_stays_put() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, live) = start("SMART-04").await?;
    let placed_text = "Gardening compost bin setup";
    let placed = new_chat(&s, placed_text).await?;
    let placed_key = format!("s:{placed}");
    let moved =
        s.gw.post(
            "/space/moves",
            json!({"expectedRevision": revision(&space(&s).await?), "sourceKey": placed_key,
                "targetKey": null, "position": "inside"}),
        )
        .await?;
    assert_eq!(moved.status, 200, "{}", moved.text);
    send(&s, &placed, placed_text).await?;
    let peer = first_message(&s, "Gardening soil mix for herbs").await?;
    let last_text = "Gardening pruning roses in spring";
    let last = new_chat(&s, last_text).await?;
    let before = space(&s).await?;
    send(&s, &last, last_text).await?;
    let view = changed_after(&s, &live, revision(&before)).await?;
    let group = &view["groups"].as_array().unwrap()[0];
    assert_eq!(group["title"], "Gardening", "{view}");
    let group_key = format!("g:{}", group["id"].as_str().unwrap());
    assert_eq!(
        members(&view, &group_key),
        sorted([format!("s:{peer}"), format!("s:{last}")]),
        "{view}"
    );
    assert_eq!(node(&view, &placed_key)["parentKey"], Value::Null, "{view}");
    assert_eq!(node(&view, &placed_key)["manualPlacement"], true, "{view}");
    assert_eq!(requests_with_message(&s, placed_text), 0);
    for request in s.provider()?.smart_group_requests() {
        let input = smart_group_input(&request).unwrap();
        assert!(
            input["candidates"]
                .as_array()
                .unwrap()
                .iter()
                .all(|candidate| !candidate["title"].to_string().contains("compost")),
            "a hand-placed conversation was offered: {input}"
        );
    }
    s.finish().await
}
