//! One instruction owner: scoped lifetime, repetition, complaint and busy capture.
use super::{forget, support};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Fixture, Scenario, Setup},
};
use serde_json::{Value, json};
const NOW: &str = "2026-10-02T04:01:00.000Z";
const ASK: &str = "Check current instruction style.";
const SEVEN: &str = "For seven days, use mango-temporary-style.";
const CHAT: &str = "In this chat, use mango-chat-style.";
const CHAT_REPEAT: &str = "Again, use mango-chat-style.";
const REPEAT: &str = "Again, use mango-temporary-style for seven days.";
const COMPLAINT: &str = "That result was bad.";
fn stub() -> Result<Cassette, HarnessError> {
    let mut cassette = forget::stub()?;
    for (user, text, duration) in [
        (SEVEN, "Use mango-temporary-style.", "7 days"),
        (REPEAT, "Use mango-temporary-style.", "7 days"),
        (CHAT, "Use mango-chat-style.", "this chat"),
        (CHAT_REPEAT, "Use mango-chat-style.", "always"),
    ] {
        support::add_call(
            &mut cassette,
            user,
            "update_explicit_memory",
            &json!({"kind":"instruction","source":user,"text":text,"duration":duration}),
        );
    }
    for user in [ASK, COMPLAINT] {
        let mut answer = cassette.exchanges[1].clone();
        answer.request.key.user_request = user.into();
        answer.request.key.round.clear();
        answer.response = support::response(
            &json!({"type":"message","id":format!("msg_duration{}",uuid::Uuid::new_v4().simple()),"role":"assistant","status":"completed","content":[{"type":"output_text","text":"What would you like me to change?","annotations":[]}]}),
        );
        cassette.exchanges.push(answer);
    }
    support::historical(&mut cassette);
    Ok(cassette)
}
async fn start(name: &str) -> Result<Scenario, HarnessError> {
    let setup = Setup::new(name)?
        .fixture(Fixture::Empty)
        .stub_cassette(stub()?)
        .env("BUTLER_E2E_APP_NOW", NOW);
    butler_e2e::e2e::fixtures::onboarding_complete(&setup.sandbox.data)?;
    butler_e2e::e2e::fixtures::scheduler_ran_today(&setup.sandbox.data, NOW)?;
    let s = forget::start(setup).await?;
    s.provider()?.set_chat_responder(behavior);
    Ok(s)
}
async fn rows(s: &Scenario) -> Result<Vec<Value>, HarnessError> {
    let reply = s.gw.get("/memory/instructions").await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data()["instructions"].as_array().unwrap().clone())
}
#[tokio::test]
async fn temporary_instruction_scopes_expiry_repetition_and_dormant_feedback()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = start("INSTRUCTION-DURATION").await?;
    let dormant = s.sandbox.data.join("cognition/feedback/feedback.md");
    std::fs::create_dir_all(dormant.parent().unwrap())?;
    std::fs::write(&dormant, "DO NOT READ dormant-owner-policy")?;
    let output = support::tool(&s, "general", SEVEN, "update_explicit_memory").await?;
    assert_eq!(output["ok"], true, "{output}");
    let a = support::new_chat(&s, "Temporary scope").await?;
    let active = prompt(&s, &a).await?;
    assert!(
        active.contains("mango-temporary-style") && active.contains("expires="),
        "{active}"
    );
    assert!(
        !s.provider()?
            .requests()
            .last()
            .unwrap()
            .to_string()
            .contains("dormant-owner-policy")
    );
    s.restart().await?;
    assert!(prompt(&s, &a).await?.contains("mango-temporary-style"));
    let repeated = support::tool(&s, "general", REPEAT, "update_explicit_memory").await?;
    assert_eq!(
        repeated["rule"], output["rule"],
        "repetition keeps one handle"
    );
    let saved = rows(&s).await?;
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0]["duration"], "always");
    assert!(saved[0]["expires_at"].is_null());
    let active = prompt(&s, &a).await?;
    assert!(active.contains("mango-temporary-style") && !active.contains("expires="));
    let before = rows(&s).await?;
    let (complaint_turn, turn) = s.turn(&a, COMPLAINT).await?;
    assert_eq!(turn["state"], "delivered");
    assert_eq!(rows(&s).await?, before, "a complaint alone stores nothing");
    assert!(
        s.gw.messages(&a)
            .await?
            .iter()
            .any(|row| row["turn_id"] == complaint_turn
                && row["role"] == "assistant"
                && row["text"] == "What would you like me to change?")
    );
    let chat = support::tool(&s, &a, CHAT, "update_explicit_memory").await?;
    assert_eq!(chat["ok"], true, "{chat}");
    assert!(prompt(&s, &a).await?.contains("mango-chat-style"));
    assert!(!prompt(&s, "general").await?.contains("mango-chat-style"));
    // Trusted fixture advances this instruction's fixed expiry without a timer or live model.
    let manifest = s.sandbox.data.join("cognition/memory/rules/manifest.json");
    let mut data: Value = serde_json::from_slice(&std::fs::read(&manifest)?)?;
    for scope in data["scopes"].as_object_mut().unwrap().values_mut() {
        for row in scope.as_object_mut().unwrap().values_mut() {
            if row["handle"] == chat["rule"] {
                row["expires_at"] = json!("2000-01-01T00:00:00Z");
            }
        }
    }
    std::fs::write(&manifest, data.to_string())?;
    assert!(!prompt(&s, &a).await?.contains("mango-chat-style"));
    assert_eq!(rows(&s).await?.len(), 1);
    daily(&mut s).await?;
    let retired = support::read_json(
        &s.sandbox
            .data
            .join("cognition/memory/rules/handles")
            .join(format!("{}.json", chat["rule"].as_str().unwrap())),
    )
    .unwrap();
    assert_eq!(retired["state"], "forgotten");
    let binding = support::read_json(&s.sandbox.data.join("cognition/memory/rules").join(format!(
        "{}.source.json",
        retired["record_id"].as_str().unwrap()
    )))
    .unwrap();
    assert_eq!(
        binding["operations"].as_array().unwrap().last().unwrap()["state"],
        "expired"
    );
    assert_eq!(
        std::fs::read_to_string(&dormant)?,
        "DO NOT READ dormant-owner-policy"
    );
    s.finish().await
}
#[tokio::test]
async fn busy_lease_instruction_capture_applies_next_turn_and_replays_after_crash()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = start("INSTRUCTION-BUSY").await?;
    let lock = s
        .sandbox
        .data
        .join("cognition/consolidation/locks/consolidation.lock.coord.sqlite");
    support::until(|| lock.exists()).await;
    let lease = butler_platform::sqlite::open(&lock).unwrap();
    lease.execute_batch("BEGIN IMMEDIATE").unwrap();
    let before = std::time::Instant::now();
    let output = support::tool(&s, "general", SEVEN, "update_explicit_memory").await?;
    assert_eq!(output["ok"], true, "{output}");
    assert_eq!(output["state"], "pending");
    let next = support::new_chat(&s, "Admission during capture").await?;
    let active = prompt(&s, &next).await?;
    assert!(active.contains("mango-temporary-style") && active.contains("expires="));
    assert_eq!(rows(&s).await?.len(), 1);
    eprintln!(
        "INSTRUCTION-BUSY capture_and_next_turn_ms={}",
        before.elapsed().as_millis()
    );
    s.agent.kill9()?;
    lease.execute_batch("ROLLBACK").unwrap();
    s.restart().await?;
    assert!(prompt(&s, &next).await?.contains("mango-temporary-style"));
    assert_eq!(rows(&s).await?.len(), 1);
    s.finish().await
}
#[tokio::test]
async fn chat_closure_retires_session_instruction_and_keeps_lasting_instruction()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = start("INSTRUCTION-CHAT-END").await?;
    let a = support::new_chat(&s, "Scoped instruction").await?;
    support::tool(&s, &a, CHAT, "update_explicit_memory").await?;
    assert_eq!(rows(&s).await?.len(), 1);
    assert!(prompt(&s, &a).await?.contains("mango-chat-style"));
    let archived =
        s.gw.patch(&format!("/sessions/{a}"), json!({"archived":true}))
            .await?;
    assert_eq!(archived.status, 200, "{}", archived.text);
    assert_eq!(rows(&s).await?, [] as [serde_json::Value; 0]);
    s.restart().await?;
    assert_eq!(rows(&s).await?, [] as [serde_json::Value; 0]);
    assert!(!prompt(&s, "general").await?.contains("mango-chat-style"));
    s.finish().await
}

fn behavior(request: &Value) -> Option<butler_e2e::e2e::cassette::ResponseRecord> {
    let raw = request["input"]
        .as_str()
        .or_else(|| request["input"][0]["content"][0]["text"].as_str())
        .unwrap_or("");
    let task = serde_json::from_str::<Value>(raw).ok();
    let output = match task.as_ref().and_then(|v| v["task"].as_str()) {
        Some("extract_profile_candidates") => Some(json!({"candidates":[]})),
        Some("general_new_chat_briefing" | "project_new_chat_briefing") => Some(
            json!({"moment":"Today","title":"Welcome","description":"Topics to discuss","suggestions":(0..4).map(|n|json!({"id":format!("topic-{n}"),"title":format!("Topic {n}"),"description":"Explore","text":"Discuss this topic","source_kind":"current_interest"})).collect::<Vec<_>>(),"title_variants":{"morning":"Welcome","afternoon":"Welcome","evening":"Welcome","night":"Welcome"}}),
        ),
        _ => None,
    };
    let text = if let Some(output) = output {
        output.to_string()
    } else {
        let key = butler_e2e::e2e::matching::key("/responses", request, &Default::default());
        if key.user_request != ASK {
            return None;
        }
        let section = support::instruction_section(request);
        if section.contains("mango-chat-style") {
            "mango-chat-style answer".into()
        } else if section.contains("mango-temporary-style") {
            "mango-temporary-style answer".into()
        } else {
            "DEFAULT answer".into()
        }
    };
    Some(support::response(
        &json!({"type":"message","id":format!("msg_durationbehavior{}",uuid::Uuid::new_v4().simple()),"role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]}),
    ))
}
async fn prompt(s: &Scenario, chat: &str) -> Result<String, HarnessError> {
    let first = s.provider()?.requests().len();
    let (id, turn) = s.turn(chat, ASK).await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let requests = s.provider()?.requests();
    let request = requests[first..]
        .iter()
        .find(|r| r["reasoning"]["effort"] == "max")
        .unwrap();
    let section = support::instruction_section(request);
    let expected = if section.contains("mango-chat-style") {
        "mango-chat-style answer"
    } else if section.contains("mango-temporary-style") {
        "mango-temporary-style answer"
    } else {
        "DEFAULT answer"
    };
    assert!(
        s.gw.messages(chat)
            .await?
            .iter()
            .any(|row| row["turn_id"] == id
                && row["role"] == "assistant"
                && row.to_string().contains(expected)),
        "missing actual styled answer {expected}"
    );
    Ok(section)
}
async fn daily(s: &mut Scenario) -> Result<(), HarnessError> {
    s.agent.terminate().await?;
    let current = s
        .agent
        .launch
        .env
        .iter()
        .find(|(key, _)| key == "BUTLER_E2E_APP_NOW")
        .unwrap()
        .1
        .clone();
    let later = chrono::DateTime::parse_from_rfc3339(&current).unwrap() + chrono::Duration::days(1);
    s.agent.launch.set_env(
        "BUTLER_E2E_APP_NOW",
        later.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    );
    for job in ["session-sync", "consolidation-cycle"] {
        let path = s.sandbox.data.join(format!("state/scheduler/{job}.json"));
        if path.exists() {
            std::fs::remove_file(path)?;
        }
    }
    s.gw = s.agent.start_again().await?;
    let marker = s
        .sandbox
        .data
        .join("state/scheduler/consolidation-cycle.json");
    support::until(|| marker.exists()).await;
    assert_eq!(support::read_json(&marker).unwrap()["status"], "ok");
    Ok(())
}
#[tokio::test]
async fn project_reset_includes_temporary_instructions_and_keeps_other_scopes()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = start("INSTRUCTION-PROJECT-RESET").await?;
    let created =
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"Instructions project"}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let project = created.data()["project"]["id"].as_str().unwrap();
    let created_chat =
        s.gw.post(
            "/sessions",
            json!({"kind":"project","title":"Project chat","project_id":project}),
        )
        .await?;
    let chat = created_chat.data()["session"]["id"].as_str().unwrap();
    support::tool(&s, "general", SEVEN, "update_explicit_memory").await?;
    support::tool(&s, chat, SEVEN, "update_explicit_memory").await?;
    support::tool(&s, chat, CHAT, "update_explicit_memory").await?;
    assert_eq!(rows(&s).await?.len(), 3);
    let view = s.gw.get(&format!("/memory/projects/{project}")).await?;
    assert_eq!(view.data()["instructions"], 2);
    super::super::memory_fixture::settle(&s.sandbox.data).await?;
    daily(&mut s).await?;
    let before = rows(&s).await?;
    reset(&s, "/memory/reset/profile").await?;
    assert_eq!(
        rows(&s).await?,
        before,
        "Profile reset preserves all temporary instructions"
    );
    reset(&s, "/memory/reset/chat-memory").await?;
    assert_eq!(
        rows(&s).await?,
        before,
        "Chat memory reset preserves all temporary instructions"
    );
    reset(&s, &format!("/memory/reset/projects/{project}")).await?;
    let remaining = rows(&s).await?;
    assert_eq!(remaining.len(), 1);
    assert!(remaining[0]["project_id"].is_null());
    assert!(!prompt(&s, chat).await?.contains("mango-chat-style"));
    assert_eq!(
        s.gw.get(&format!("/memory/projects/{project}"))
            .await?
            .data()["instructions"],
        0
    );
    s.finish().await
}

#[tokio::test]
async fn instruction_capture_never_waits_for_an_active_owner_transaction()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("INSTRUCTION-ACTIVE-LEASE")?
        .fixture(Fixture::Empty)
        .stub_cassette(stub()?)
        .env("BUTLER_E2E_RULE_CRASH_POINTS", "1");
    let mut s = forget::start(setup).await?;
    s.provider()?.set_chat_responder(behavior);
    let original = support::tool(&s, "general", forget::GLOBAL, "update_explicit_memory").await?;
    s.provider()?
        .add_placeholder("TARGET", original["rule"].as_str().unwrap());
    let state = s.sandbox.data.join("state");
    std::fs::write(
        state.join("rule-crash-arm.json"),
        json!({"stage":"intent"}).to_string(),
    )?;
    butler_e2e::e2e::scenario::accepted_turn_id(&s.gw.say("general", forget::CORRECT).await?)?;
    support::until(|| state.join("rule-crash-reached.json").exists()).await;
    let other = support::new_chat(&s, "Capture while a canonical writer is active").await?;
    let captured = support::tool(&s, &other, SEVEN, "update_explicit_memory").await?;
    assert_eq!(captured["ok"], true, "{captured}");
    assert_eq!(captured["state"], "pending");
    assert!(prompt(&s, &other).await?.contains("mango-temporary-style"));
    s.agent.kill9()?;
    s.restart().await?;
    assert!(prompt(&s, &other).await?.contains("mango-temporary-style"));
    assert_eq!(rows(&s).await?.len(), 2);
    s.finish().await
}

async fn reset(s: &Scenario, route: &str) -> Result<(), HarnessError> {
    eprintln!("INSTRUCTION-RESET route={route} started");
    super::super::memory_fixture::settle(&s.sandbox.data).await?;
    let summary = s.gw.post("/memory/inventory/check", json!({})).await?;
    assert_eq!(summary.status, 200, "{}", summary.text);
    let id = uuid::Uuid::new_v4().to_string();
    let reset =
        s.gw.post(
            route,
            json!({"operation_id":id,"inventory_revision":summary.data()["revision"]}),
        )
        .await?;
    assert_eq!(reset.status, 202, "{}", reset.text);
    tokio::time::timeout(std::time::Duration::from_secs(90), async {
        loop {
            let status = s.gw.get(&format!("/memory/reset/{id}")).await?;
            // A committed cutover can still have a retirement writer queued.
            // Finish that owned work before measuring the next reset once.
            if status.data()["phase"] == "complete" && status.data()["removal_pending"] == false {
                return Ok::<_, HarnessError>(());
            }
            assert_ne!(status.data()["phase"], "failed", "{}", status.text);
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("accepted instruction reset did not complete within its original 90s deadline")?;
    eprintln!("INSTRUCTION-RESET route={route} complete");
    Ok(())
}

#[tokio::test]
async fn repeating_session_instruction_as_lasting_keeps_one_handle() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = start("INSTRUCTION-SESSION-REPEAT").await?;
    let chat = support::new_chat(&s, "Session repeat").await?;
    let temporary = support::tool(&s, &chat, CHAT, "update_explicit_memory").await?;
    let lasting = support::tool(&s, &chat, CHAT_REPEAT, "update_explicit_memory").await?;
    assert_eq!(lasting["rule"], temporary["rule"]);
    let saved = rows(&s).await?;
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0]["duration"], "always");
    assert!(saved[0]["scope_session_id"].is_null() && saved[0]["expires_at"].is_null());
    assert_eq!(
        s.gw.patch(&format!("/sessions/{chat}"), json!({"archived":true}))
            .await?
            .status,
        200
    );
    assert!(prompt(&s, "general").await?.contains("mango-chat-style"));
    s.finish().await
}
