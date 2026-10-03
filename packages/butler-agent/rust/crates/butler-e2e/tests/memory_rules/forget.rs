//! Exact-binding mutations and read-only adoption of supported older rules.
use super::support;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Fixture, Scenario, Setup},
};
use serde_json::{Value, json};

pub(super) const ASK: &str = "Say hello in one sentence.";
pub(super) const GLOBAL: &str =
    "Remember this durable explicit rule: my bike lock code is 5400. Use update_explicit_memory.";
pub(super) const A: &str = "Remember this durable explicit project rule: my bike lock code is 5401. Use update_explicit_memory.";
pub(super) const B: &str = "Remember this durable explicit project rule: my bike lock code is 5402. Use update_explicit_memory.";
pub(super) const CORRECT: &str =
    "Correct this remembered bike lock rule to 6401 using update_explicit_memory with replaces.";
pub(super) const FORGET: &str =
    "Forget this saved bike lock rule using forget_explicit_memory. Keep my chats.";
const VECTOR: &str = "Recall my bicycle security cable combinations from all chats.";
pub(super) const RECALL: &str = "Recall my bike lock rules from all chats.";

pub(super) fn stub() -> Result<Cassette, HarnessError> {
    let mut cassette = Cassette::load("MEM-01")?;
    for (user, text) in [(GLOBAL, "5400"), (A, "5401"), (B, "5402")] {
        support::add_call(
            &mut cassette,
            user,
            "update_explicit_memory",
            &json!({"kind":"rule","text":format!("The user's bike lock code is {text}."),"source":user}),
        );
    }
    support::add_call(
        &mut cassette,
        CORRECT,
        "update_explicit_memory",
        &json!({"kind":"rule","text":"The user's bike lock code is 6401.","source":CORRECT,"replaces":"{{TARGET}}"}),
    );
    support::add_call(
        &mut cassette,
        FORGET,
        "forget_explicit_memory",
        &json!({"rule":"{{TARGET}}","source":FORGET}),
    );
    support::add_call(
        &mut cassette,
        RECALL,
        "recall_memory",
        &json!({"cue":"bike lock code","scope":"all_user_sessions"}),
    );
    support::add_call(
        &mut cassette,
        VECTOR,
        "recall_memory",
        &json!({"cue":"bicycle security cable combinations","scope":"all_user_sessions","include_vector":true}),
    );
    let mut answer = cassette.exchanges[1].clone();
    answer.request.key.user_request = ASK.into();
    answer.request.key.round.clear();
    answer.response = support::response(
        &json!({"type":"message","id":"msg_rulesgreeting0000","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Hello.","annotations":[]}]}),
    );
    cassette.exchanges.push(answer);
    support::historical(&mut cassette);
    Ok(cassette)
}

pub(super) async fn start(setup: Setup) -> Result<Scenario, HarnessError> {
    let s = setup.start().await?;
    s.provider()?.set_memory_responder(support::meaning);
    s.patch_settings(json!({"access_mode":"full_access","onboarding":{
        "consent_version":1,"accepted_at":"2026-10-02T00:00:00.000Z","completed_at":"2026-10-02T00:00:00.000Z"}}),"onboarding").await?;
    s.select_model(&s.model).await?;
    support::until(|| {
        s.sandbox
            .data
            .join("cognition/memory/active-generation.json")
            .exists()
    })
    .await;
    Ok(s)
}

async fn project_chat(s: &Scenario, name: &str) -> Result<(String, String), HarnessError> {
    let reply =
        s.gw.post("/projects", json!({"source":"scratch","display_name":name}))
            .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let project = reply.data()["project"]["id"].as_str().unwrap().to_owned();
    let reply =
        s.gw.post(
            "/sessions",
            json!({"kind":"project","title":name,"project_id":project}),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    Ok((
        project,
        reply.data()["session"]["id"].as_str().unwrap().to_owned(),
    ))
}

fn target(s: &Scenario, row: &Value) -> Result<(), HarnessError> {
    s.provider()?
        .add_placeholder("TARGET", row["handle"].as_str().unwrap());
    Ok(())
}

#[tokio::test]
async fn rules_forget_and_correction_preserve_other_bindings_after_restart()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("RULES-FORGET-BINDING")?
        .fixture(Fixture::Empty)
        .stub_cassette(stub()?);
    assert!(butler_e2e::e2e::fixtures::embedding_assets(
        &setup.sandbox.data
    )?);
    let mut s = start(setup).await?;
    let (pa, ca) = project_chat(&s, "A").await?;
    let (pb, cb) = project_chat(&s, "B").await?;
    for (chat, user) in [("general", GLOBAL), (ca.as_str(), A), (cb.as_str(), B)] {
        let output = support::tool(&s, chat, user, "update_explicit_memory").await?;
        assert_eq!(output["ok"], true, "{output}");
    }
    let rows = support::active_rules(&s.sandbox.data);
    assert_eq!(rows.len(), 3);
    let global = rows.iter().find(|row| row["project_id"].is_null()).unwrap();
    let ra = rows.iter().find(|row| row["project_id"] == pa).unwrap();
    let rb = rows.iter().find(|row| row["project_id"] == pb).unwrap();
    for row in &rows {
        support::projection(&s.sandbox.data, row).await;
    }
    let rules = s.sandbox.data.join("cognition/memory/rules");
    let prior = std::fs::read(rules.join("manifest.json"))?;
    for (chat, row, code) in [
        ("general", ra, "rule_not_in_snapshot"),
        (cb.as_str(), ra, "rule_not_in_snapshot"),
        (ca.as_str(), global, "rule_binding_mismatch"),
    ] {
        target(&s, row)?;
        for (user, name) in [
            (CORRECT, "update_explicit_memory"),
            (FORGET, "forget_explicit_memory"),
        ] {
            let output = support::tool(&s, chat, user, name).await?;
            assert_eq!(output["ok"], false, "{output}");
            assert_eq!(output["error"]["code"], code, "{output}");
            assert_eq!(std::fs::read(rules.join("manifest.json"))?, prior);
            assert!(!rules.join("pending.json").exists());
        }
    }
    target(&s, ra)?;
    let output = support::tool(&s, &ca, CORRECT, "update_explicit_memory").await?;
    assert_eq!(output["ok"], true, "{output}");
    let corrected = support::active_rules(&s.sandbox.data)
        .into_iter()
        .find(|row| row["handle"] == ra["handle"])
        .unwrap();
    support::projection(&s.sandbox.data, &corrected).await;
    let recalled = support::tool(&s, &ca, RECALL, "recall_memory").await?;
    let evidence = support::typed_evidence(&recalled);
    for text in ["5400", "6401", "5402"] {
        assert!(
            evidence.iter().any(|row| row.to_string().contains(text)),
            "{recalled}"
        );
    }
    let before = support::active_section(&s, &cb, ASK).await?;
    assert!(before.contains("5400") && before.contains("5402") && !before.contains("6401"));
    support::vectors(&s.sandbox.data).await;
    let graph_before = support::retained_graph_rows(&s.sandbox.data);
    let output = support::tool(&s, &ca, FORGET, "forget_explicit_memory").await?;
    assert_eq!(output["ok"], true, "{output}");
    assert_eq!(output["state"], "forgotten");
    let graph_after = support::retained_graph_rows(&s.sandbox.data);
    for (before, after) in graph_before.iter().zip(&graph_after) {
        assert!(
            before.iter().all(|id| after.contains(id)),
            "forget removed graph nodes or evidence"
        );
    }
    assert!(output.get("recall_state").is_none());
    let current = support::active_rules(&s.sandbox.data);
    assert_eq!(current.len(), 2);
    assert_eq!(
        current
            .iter()
            .find(|row| row["handle"] == rb["handle"])
            .unwrap(),
        rb
    );
    assert_eq!(
        current
            .iter()
            .find(|row| row["handle"] == global["handle"])
            .unwrap(),
        global
    );
    let after = support::active_section(&s, &ca, ASK).await?;
    assert!(
        after.contains("5400")
            && !after.contains("6401")
            && !after.contains("5401")
            && !after.contains("5402")
    );
    let recalled = support::tool(&s, &ca, RECALL, "recall_memory").await?;
    let evidence = support::typed_evidence(&recalled);
    assert!(
        evidence
            .iter()
            .all(|row| !row.to_string().contains("5401") && !row.to_string().contains("6401")),
        "{recalled}"
    );
    for text in ["5400", "5402"] {
        assert!(
            evidence.iter().any(|row| row.to_string().contains(text)),
            "{recalled}"
        );
    }
    let archive = rules
        .join("archive")
        .join(ra["record_id"].as_str().unwrap())
        .join(format!("{}.json", corrected["revision"].as_str().unwrap()));
    assert!(
        support::read_json(&archive).unwrap()["text"]
            .as_str()
            .unwrap()
            .contains("6401")
    );
    support::vectors(&s.sandbox.data).await;
    s.restart().await?;
    assert_eq!(support::active_section(&s, &cb, ASK).await?, before);
    assert_eq!(support::active_section(&s, &ca, ASK).await?, after);
    let recalled = support::tool(&s, &ca, RECALL, "recall_memory").await?;
    let evidence = support::typed_evidence(&recalled);
    assert!(
        evidence
            .iter()
            .all(|row| !row.to_string().contains("5401") && !row.to_string().contains("6401")),
        "{recalled}"
    );
    let (warm_turn, turn) = s.turn(&ca, ASK).await?;
    assert_eq!(turn["state"], "delivered");
    support::conversation_vectors(&s.sandbox.data, &warm_turn).await;
    let vectors = support::tool(&s, &ca, VECTOR, "recall_memory").await?;
    assert_eq!(vectors["ok"], true, "{vectors}");
    let typed = support::typed_evidence(&vectors);
    assert_eq!(typed.len(), 2, "{vectors}");
    for code in ["5400", "5402"] {
        assert!(
            typed.iter().any(|row| row.to_string().contains(code)),
            "{vectors}"
        );
    }
    assert!(
        typed
            .iter()
            .all(|row| !row.to_string().contains("5401") && !row.to_string().contains("6401")),
        "{vectors}"
    );
    assert!(
        vectors["results"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["channels"]
                .as_array()
                .is_some_and(|lanes| lanes.iter().any(|lane| lane == "vector"))),
        "{vectors}"
    );
    assert!(
        s.gw.messages(&ca)
            .await?
            .iter()
            .any(|row| row.to_string().contains("5401")),
        "forget erased chats"
    );
    eprintln!(
        "RULES-FORGET-BINDING active_before=3 active_after=2 other_bindings_unchanged=true forgotten_vectors_excluded=true"
    );
    s.finish().await?;
    Ok(())
}

#[tokio::test]
async fn older_rules_keep_complete_text_and_global_handles_until_forget() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let setup = Setup::new("RULES-OLDER")?
        .fixture(Fixture::Empty)
        .stub_cassette(stub()?);
    let mut s = start(setup).await?;
    s.agent.terminate().await?;
    let rules = s.sandbox.data.join("cognition/memory/rules");
    std::fs::create_dir_all(&rules)?;
    let text = format!(
        "# Remembered rule\n\n{}\nComplete ending: older-rule-marker.\n",
        "Full text. ".repeat(900)
    );
    std::fs::write(rules.join("older-rule.md"), &text)?;
    std::fs::write(
        rules.join("INDEX.md"),
        "# Rules\n- [Old rule](older-rule.md)\n",
    )?;
    s.restart().await?;
    let section = support::active_section(&s, "general", ASK).await?;
    let handle = regex::Regex::new(r"\[(R[A-F0-9]{10,64})\] scope=all")
        .unwrap()
        .captures(&section)
        .unwrap()[1]
        .to_owned();
    assert!(section.contains("older-rule-marker"));
    assert_eq!(
        section.matches("Full text.").count(),
        900,
        "rule content was truncated"
    );
    assert_eq!(std::fs::read_to_string(rules.join("older-rule.md"))?, text);
    assert!(!rules.join("manifest.json").exists());
    assert!(!rules.join("older-rule.source.json").exists());
    assert_eq!(support::active_section(&s, "general", ASK).await?, section);
    s.provider()?.add_placeholder("TARGET", &handle);
    s.patch_settings(json!({"access_mode":"read_only"}), "access")
        .await?;
    let output = support::tool(&s, "general", FORGET, "forget_explicit_memory").await?;
    assert_eq!(output["ok"], false, "{output}");
    assert!(!rules.join("manifest.json").exists());
    assert!(!rules.join("pending.json").exists());
    s.patch_settings(json!({"access_mode":"ask_first"}), "access")
        .await?;
    let output = support::tool(&s, "general", FORGET, "forget_explicit_memory").await?;
    assert_eq!(output["ok"], false, "{output}");
    assert!(!rules.join("manifest.json").exists());
    assert!(!rules.join("pending.json").exists());
    s.patch_settings(json!({"access_mode":"full_access"}), "access")
        .await?;
    let output = support::tool(&s, "general", FORGET, "forget_explicit_memory").await?;
    assert_eq!(output["ok"], true, "{output}");
    assert_eq!(output["rule"], handle);
    assert!(support::active_rules(&s.sandbox.data).is_empty());
    assert_eq!(std::fs::read_to_string(rules.join("older-rule.md"))?, text);
    let binding = support::read_json(&rules.join("older-rule.source.json")).unwrap();
    assert!(binding["project_id"].is_null());
    assert_eq!(binding["state"], "forgotten");
    let archives =
        std::fs::read_dir(rules.join("archive/older-rule"))?.collect::<Result<Vec<_>, _>>()?;
    assert_eq!(archives.len(), 1);
    assert_eq!(
        support::read_json(&archives[0].path()).unwrap()["text"],
        text
    );
    s.restart().await?;
    s.patch_settings(json!({"access_mode":"full_access"}), "access")
        .await?;
    assert!(
        !support::active_section(&s, "general", ASK)
            .await?
            .contains("older-rule-marker")
    );
    let output = support::tool(&s, "general", FORGET, "forget_explicit_memory").await?;
    assert_eq!(output["error"]["code"], "rule_not_in_snapshot", "{output}");
    assert_eq!(
        std::fs::read_dir(rules.join("archive/older-rule"))?.count(),
        1
    );
    eprintln!(
        "RULES-OLDER full_text_bytes={} active_after=0 listing_writes=0",
        text.len()
    );
    s.finish().await?;
    Ok(())
}
