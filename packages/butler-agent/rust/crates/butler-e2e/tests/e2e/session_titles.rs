//! Automatic titles through native admission, storage and live App events.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
use butler_e2e::e2e::{
    HarnessError,
    cassette::{Cassette, Exchange},
    events::LiveEvents,
    faults::{Fault, Transform},
    provider::is_title_request,
    scenario::{Fixture, Scenario, Setup},
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
const TITLE: &str = "Planning a Simple Reply";

async fn start(name: &str) -> Result<(Scenario, String), HarnessError> {
    let mut cassette = Cassette::load("Q-02")?;
    cassette.meta.model = "openai/gpt-6.1-sol".into();
    cassette.meta.effort = Some("medium".into());
    for exchange in &mut cassette.exchanges {
        exchange.request.key.model = "gpt-6.1-sol".into();
        exchange.request.key.effort = Some("medium".into());
    }
    let prompt = cassette.exchanges[0].request.key.user_request.clone();
    let mut title: Exchange = cassette.exchanges.last().unwrap().clone();
    title.request.key.user_request = format!("User message: {prompt}");
    title.request.key.round.clear();
    title.request.key.effort = Some("low".into());
    title.response = butler_e2e::e2e::provider::title_response("\"# Planning a Simple Reply.\"");
    cassette.exchanges.push(title);
    let setup = Setup::new(name)?
        .fixture(Fixture::Empty)
        .stub_cassette(cassette);
    butler_e2e::e2e::fixtures::scheduler_ran_today(
        &setup.sandbox.data,
        butler_e2e::e2e::fixtures::FIXTURE_TIME,
    )?;
    butler_e2e::e2e::fixtures::onboarding_complete(&setup.sandbox.data)?;
    let s = setup.start().await?;
    s.gw.patch("/settings", json!({"access_mode":"full_access"}))
        .await?;
    Ok((s, prompt))
}

async fn chat(s: &Scenario, title: &str, prompt: &str) -> Result<String, HarnessError> {
    let reply =
        s.gw.post(
            "/sessions",
            json!({"kind":"chat", "title":title,
        "initial_message":prompt}),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    Ok(reply.data()["session"]["id"].as_str().unwrap().into())
}

async fn title(s: &Scenario, chat: &str) -> Result<Value, HarnessError> {
    let reply = s.gw.get("/sessions").await?;
    Ok(reply.data()["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == chat)
        .unwrap()["title"]
        .clone())
}

async fn wait_requests(s: &Scenario, count: usize) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while s
            .provider()
            .unwrap()
            .requests()
            .iter()
            .filter(|r| is_title_request(r))
            .count()
            < count
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("title request missing");
}

#[tokio::test]
async fn title_01_first_exchange_replaces_provisional_title() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, prompt) = start("TITLE-01").await?;
    let chat = chat(&s, &provisional(&prompt), &prompt).await?;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let started = Instant::now();
    let (turn, latency) = tokio::join!(s.turn(&chat, &prompt), async {
        live.wait_for(Duration::from_secs(5), |e| {
            e["type"] == "session.updated"
                && e["payload"]["session"]["id"] == chat
                && e["payload"]["session"]["title"] == TITLE
        })
        .await?;
        Ok::<_, HarnessError>(started.elapsed().as_millis())
    });
    assert_eq!(turn?.1["state"], "delivered");
    eprintln!("TITLE-01 title latency_ms={}", latency?);
    assert_eq!(title(&s, &chat).await?, TITLE);
    let requests = s.provider()?.requests();
    let titles: Vec<_> = requests.iter().filter(|r| is_title_request(r)).collect();
    assert_eq!(titles.len(), 1);
    assert_eq!(titles[0]["model"], "gpt-6.1-sol");
    assert_eq!(titles[0]["reasoning"]["effort"], "low");
    let (_, turn) = s.turn(&chat, &prompt).await?;
    assert_eq!(turn["state"], "delivered");
    assert_eq!(
        s.provider()?
            .requests()
            .iter()
            .filter(|r| is_title_request(r))
            .count(),
        1
    );
    s.restart().await?;
    assert_eq!(title(&s, &chat).await?, TITLE);
    s.finish().await
}

#[tokio::test]
async fn title_02_user_rename_wins() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, prompt) = start("TITLE-02").await?;
    let chat = chat(&s, &provisional(&prompt), &prompt).await?;
    let held = s.provider()?.hold_next_reply("User message:");
    let (_, turn) = s.turn(&chat, &prompt).await?;
    assert_eq!(turn["state"], "delivered");
    wait_requests(&s, 1).await;
    s.gw.patch(
        &format!("/sessions/{chat}"),
        json!({"title":"My chosen title"}),
    )
    .await?;
    held.release();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(title(&s, &chat).await?, "My chosen title");
    s.finish().await
}

#[tokio::test]
async fn title_03_failure_logged_keeps_provisional() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, prompt) = start("TITLE-03").await?;
    let chat = chat(&s, &provisional(&prompt), &prompt).await?;
    s.provider()?.inject(Fault::on_request(
        &format!("User message: {prompt}"),
        0,
        Transform::ErrorFromLibrary("codex-401".into()),
    ))?;
    let (_, turn) = s.turn(&chat, &prompt).await?;
    assert_eq!(turn["state"], "delivered");
    tokio::time::timeout(Duration::from_secs(6), async {
        while !s.agent.logs().contains("[session-title]") {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("title failure was not logged");
    assert_eq!(title(&s, &chat).await?, provisional(&prompt));
    assert!(!s.agent.logs().contains(&prompt));
    assert_eq!(
        s.agent
            .logs()
            .lines()
            .filter(|line| line.contains("[session-title]"))
            .count(),
        1
    );
    s.finish().await
}

#[tokio::test]
async fn title_04_general_and_custom_titles_untouched() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, prompt) = start("TITLE-04").await?;
    let chat = chat(&s, "My chosen title", &prompt).await?;
    for id in ["general", &chat] {
        let (_, turn) = s.turn(id, &prompt).await?;
        assert_eq!(turn["state"], "delivered");
    }
    assert_eq!(title(&s, &chat).await?, "My chosen title");
    assert!(!s.provider()?.requests().iter().any(is_title_request));
    s.finish().await
}

fn provisional(prompt: &str) -> String {
    let line = prompt
        .trim()
        .split_once('\n')
        .map_or(prompt.trim(), |(first, _)| first)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if line.encode_utf16().count() > 48 {
        format!(
            "{}...",
            String::from_utf16_lossy(&line.encode_utf16().take(45).collect::<Vec<_>>())
        )
    } else {
        line
    }
}

#[tokio::test]
async fn title_05_deadline_keeps_provisional_and_logs_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, prompt) = start("TITLE-05").await?;
    let chat = chat(&s, &provisional(&prompt), &prompt).await?;
    s.provider()?.inject(Fault::on_request(
        &format!("User message: {prompt}"),
        0,
        Transform::StallAfter(0),
    ))?;
    let (_, turn) = s.turn(&chat, &prompt).await?;
    assert_eq!(turn["state"], "delivered");
    tokio::time::timeout(Duration::from_secs(6), async {
        while !s.agent.logs().contains("reason=timeout") {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("title deadline missing");
    assert_eq!(title(&s, &chat).await?, provisional(&prompt));
    assert_eq!(
        s.agent
            .logs()
            .lines()
            .filter(|line| line.contains("[session-title]"))
            .count(),
        1
    );
    s.finish().await
}

#[tokio::test]
async fn title_06_shutdown_cancels_held_generation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, prompt) = start("TITLE-06").await?;
    let chat = chat(&s, &provisional(&prompt), &prompt).await?;
    let held = s.provider()?.hold_next_reply("User message:");
    let (_, turn) = s.turn(&chat, &prompt).await?;
    assert_eq!(turn["state"], "delivered");
    wait_requests(&s, 1).await;
    s.restart().await?;
    held.release();
    assert_eq!(title(&s, &chat).await?, provisional(&prompt));
    assert_eq!(
        s.provider()?
            .requests()
            .iter()
            .filter(|r| is_title_request(r))
            .count(),
        1
    );
    s.finish().await
}

#[tokio::test]
async fn title_07_queued_followup_does_not_generate_again() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, prompt) = start("TITLE-07").await?;
    let chat = chat(&s, &provisional(&prompt), &prompt).await?;
    let title_reply = s.provider()?.hold_next_reply("User message:");
    let turn_reply = s.provider()?.hold_next_reply(&prompt);
    let first = s.gw.say(&chat, &prompt).await?;
    wait_requests(&s, 1).await;
    let second = s.gw.say(&chat, &prompt).await?;
    assert!(second["accepted"].is_null(), "{second}");
    assert!(!second["queued"].is_null(), "{second}");
    title_reply.release();
    tokio::time::timeout(Duration::from_secs(5), async {
        while title(&s, &chat).await? != TITLE {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok::<_, HarnessError>(())
    })
    .await
    .expect("first title missing")?;
    turn_reply.release();
    let id = butler_e2e::e2e::scenario::accepted_turn_id(&first)?;
    assert_eq!(
        s.gw.wait_terminal(&chat, &id, Duration::from_secs(5))
            .await?["state"],
        "delivered"
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let turns = s.gw.turns(&chat).await?;
            if turns.len() == 2 && turns.iter().all(|t| t["state"] == "delivered") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok::<_, HarnessError>(())
    })
    .await
    .expect("followup not delivered")?;
    assert_eq!(
        s.provider()?
            .requests()
            .iter()
            .filter(|r| is_title_request(r))
            .count(),
        1
    );
    s.finish().await
}
