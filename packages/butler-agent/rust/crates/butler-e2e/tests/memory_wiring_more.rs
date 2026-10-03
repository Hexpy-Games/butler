//! Second wiring audit: supported ingress only, fresh DATA, stub models.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::cassette::Cassette;
use butler_e2e::e2e::faults::{ArgsMutation, mutate_chunk};
use butler_e2e::e2e::scenario::{Fixture, Setup};
use serde_json::json;
#[path = "memory_rules/crash.rs"]
mod crash;
#[path = "memory_rules/cursor.rs"]
mod cursor;
#[path = "memory_rules/duration.rs"]
mod duration;
#[path = "memory_rules/failure.rs"]
mod failure;
#[path = "memory_rules/forget.rs"]
mod forget;
#[path = "memory_rules/support.rs"]
mod support;
use support::{new_chat, read_json, until};

fn correction_stub() -> Result<(Cassette, String, String, String), HarnessError> {
    let mut cassette = Cassette::load("MEM-01")?;
    let save = cassette.exchanges[0].request.key.user_request.clone();
    let correction = "Correction: my bike lock code is now 8642, replacing the previous code. Use your explicit memory tool to correct the remembered rule.".to_owned();
    let mut corrected = cassette.exchanges.clone();
    let mutation = ArgsMutation::Replace {
        from: "The user's bike lock code is {{NONCE}}.".into(),
        to: "The user's bike lock code is 8642.".into(),
    };
    // Distinct turns receive distinct provider object/call IDs, as a real
    // provider would; copying a recording must not create duplicate IDs.
    // Recorded ID suffixes are long; requiring eight characters preserves
    // the JSON field name `call_id` itself.
    let ids = regex::Regex::new(r"\b((?:resp|msg|fc|rs|call)_[A-Za-z0-9]{8,})").unwrap();
    for exchange in &mut corrected {
        exchange.request.key.user_request = correction.clone();
        for chunk in &mut exchange.response.chunks {
            chunk.text = mutate_chunk(&chunk.text, &mutation);
            chunk.text = ids.replace_all(&chunk.text, "${1}correction").into_owned();
        }
    }
    corrected[0].response = support::response(
        &json!({"type":"function_call","id":"fc_targeted_correction",
        "call_id":"call_targeted_correction","name":"update_explicit_memory","status":"completed",
        "arguments":json!({"kind":"rule","text":"The user's bike lock code is 8642.",
            "source":"User correction", "replaces":"{{RULE}}"}).to_string()}),
    );
    cassette.exchanges.extend(corrected);
    let ask = "Say hello in one sentence.".to_owned();
    let mut answer = cassette.exchanges[1].clone();
    answer.request.key.user_request = ask.clone();
    answer.request.key.round.clear();
    for chunk in &mut answer.response.chunks {
        chunk.text = ids.replace_all(&chunk.text, "${1}greeting").into_owned();
    }
    cassette.exchanges.push(answer);
    support::add_call(
        &mut cassette,
        "Recall my bike lock code from all chats.",
        "recall_memory",
        &json!({"cue":"bike lock code","scope":"all_user_sessions"}),
    );
    support::add_call(
        &mut cassette,
        "Recall my bicycle security cable combination from all chats.",
        "recall_memory",
        &json!({"cue":"bicycle security cable combination","scope":"all_user_sessions"}),
    );
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
    Ok((cassette, save, correction, ask))
}

/// A correction is a supported use of update_explicit_memory. The old value
/// must leave mandatory Active Rules in a new chat after the correction.
#[tokio::test]
async fn wiring_more_correction_supersedes_previous_rule_in_next_prompt() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (cassette, save, correction, ask) = correction_stub()?;
    let setup = Setup::new("WIRING-MORE-CORRECTION")?
        .fixture(Fixture::Empty)
        .stub_cassette(cassette)
        .placeholder("NONCE", "5317");
    assert!(!setup.sandbox.data.join("cognition").exists());
    assert!(butler_e2e::e2e::fixtures::embedding_assets(
        &setup.sandbox.data
    )?);
    let mut s = setup.start().await?;
    s.provider()?.set_memory_responder(support::meaning);
    // Complete onboarding through the supported settings API, not a fixture.
    s.patch_settings(
        json!({"onboarding": {
            "consent_version": 1, "accepted_at": "2026-10-02T00:00:00.000Z",
            "completed_at": "2026-10-02T00:00:00.000Z"
        }}),
        "onboarding",
    )
    .await?;
    s.select_model(&s.model).await?;
    until(|| {
        s.sandbox
            .data
            .join("cognition/memory/active-generation.json")
            .exists()
    })
    .await;
    let correction_chat = new_chat(&s, "Correct saved rule").await?;
    let output = support::tool(
        &s,
        "general",
        &save.replace("{{NONCE}}", "5317"),
        "update_explicit_memory",
    )
    .await?;
    assert_eq!(output["ok"], true, "{output}");
    let old = support::active_rules(&s.sandbox.data).pop().unwrap();
    support::projection(&s.sandbox.data, &old).await;
    let before = support::tool(
        &s,
        "general",
        "Recall my bike lock code from all chats.",
        "recall_memory",
    )
    .await?;
    assert!(
        support::typed_evidence(&before)
            .iter()
            .any(|row| row.to_string().contains("5317")),
        "{before}"
    );
    s.provider()?
        .add_placeholder("RULE", old["handle"].as_str().unwrap());
    let output = support::tool(&s, &correction_chat, &correction, "update_explicit_memory").await?;
    assert_eq!(output["ok"], true, "{output}");
    assert_eq!(output["rule"], old["handle"]);
    assert_eq!(output["recall_state"], "pending");
    let immediate_section = support::active_section(&s, &correction_chat, &ask).await?;
    assert!(immediate_section.contains("8642") && !immediate_section.contains("5317"));
    assert_eq!(immediate_section.matches("8642").count(), 1);
    assert!(
        immediate_section.contains(&format!("[{}] scope=all", old["handle"].as_str().unwrap()))
    );
    let immediate = support::tool(
        &s,
        "general",
        "Recall my bike lock code from all chats.",
        "recall_memory",
    )
    .await?;
    assert_eq!(immediate["ok"], true, "{immediate}");
    assert!(
        support::typed_evidence(&immediate)
            .iter()
            .all(|row| !row.to_string().contains("5317")),
        "{immediate}"
    );
    let latest = support::active_rules(&s.sandbox.data).pop().unwrap();
    assert_eq!(latest["record_id"], old["record_id"]);
    assert_ne!(latest["revision"], old["revision"]);
    let archive = s
        .sandbox
        .data
        .join("cognition/memory/rules/archive")
        .join(old["record_id"].as_str().unwrap())
        .join(format!("{}.json", old["revision"].as_str().unwrap()));
    let archived = read_json(&archive).unwrap();
    assert!(archived["text"].as_str().unwrap().contains("5317"));
    assert_eq!(archived["binding"]["revision"], old["revision"]);
    support::projection(&s.sandbox.data, &latest).await;
    support::vectors(&s.sandbox.data).await;
    s.restart().await?;
    let rules = s.sandbox.data.join("cognition/memory/rules");
    let index = std::fs::read_to_string(rules.join("INDEX.md"))?;
    assert!(index.contains("8642"), "correction was not saved: {index}");
    let bindings = std::fs::read_dir(&rules)?
        .map(Result::unwrap)
        .map(|entry| entry.path())
        .filter(|path| path.to_string_lossy().ends_with(".source.json"))
        .filter_map(|path| read_json(&path))
        .collect::<Vec<_>>();
    let active = bindings.iter().filter(|v| v["state"] == "active").count();
    let chat = new_chat(&s, "After correction").await?;
    let first = s.provider()?.requests().len();
    let (greeting_turn, turn) = s.turn(&chat, &ask).await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let requests = s.provider()?.requests();
    let request = requests[first..]
        .iter()
        .find(|r| r["reasoning"]["effort"] == "max")
        .unwrap();
    let section = support::instruction_section(request);
    assert_eq!(
        section, immediate_section,
        "unchanged rules changed prompt bytes across restart"
    );
    let old = section.contains("5317");
    let new = section.contains("8642");
    eprintln!(
        "WIRING-MORE-CORRECTION active_bindings={active} old_in_prompt={old} new_in_prompt={new}"
    );
    let recalled = support::tool(
        &s,
        &chat,
        "Recall my bike lock code from all chats.",
        "recall_memory",
    )
    .await?;
    // Ordinary turns leave vectors deferred; this recall starts the owned batch.
    support::conversation_vectors(&s.sandbox.data, &greeting_turn).await;
    assert_eq!(recalled["ok"], true, "{recalled}");
    let typed = support::typed_evidence(&recalled);
    assert!(
        !typed.is_empty(),
        "new typed revision was not recalled: {recalled}"
    );
    assert!(
        typed.iter().any(|row| row.to_string().contains("8642")),
        "{recalled}"
    );
    assert!(
        typed.iter().all(|row| !row.to_string().contains("5317")),
        "{recalled}"
    );
    let vectors = support::tool(
        &s,
        &chat,
        "Recall my bicycle security cable combination from all chats.",
        "recall_memory",
    )
    .await?;
    assert_eq!(vectors["ok"], true, "{vectors}");
    let evidence = support::typed_evidence(&vectors);
    assert!(
        evidence.iter().any(|row| row.to_string().contains("8642")),
        "{vectors}"
    );
    assert!(
        evidence.iter().all(|row| !row.to_string().contains("5317")),
        "{vectors}"
    );
    assert!(
        vectors["results"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["channels"]
                .as_array()
                .is_some_and(|channels| channels.iter().any(|lane| lane == "vector"))),
        "{vectors}"
    );
    assert_eq!(active, 1);
    s.finish().await?;
    assert!(new, "latest correction missing from next prompt");
    assert!(
        !old,
        "superseded bike code is still a mandatory Active Rule; active bindings={active}"
    );
    Ok(())
}
