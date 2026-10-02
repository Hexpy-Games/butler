//! Stale turn snapshots and real index I/O failure leave truthful recoverable state.
use super::{forget, support};
use butler_e2e::e2e::{
    HarnessError,
    faults::{Fault, Transform},
    scenario::{Fixture, Setup, accepted_turn_id},
};
use serde_json::json;
use std::time::Duration;

const STALE: &str =
    "Correct this remembered bike lock rule to 7400 using update_explicit_memory with replaces.";

#[tokio::test]
async fn rules_stale_snapshot_refuses_mutation_and_io_failure_recovers() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let mut cassette = forget::stub()?;
    support::add_call(
        &mut cassette,
        STALE,
        "update_explicit_memory",
        &json!({"kind":"rule","text":"The user's bike lock code is 7400.","source":STALE,"replaces":"{{TARGET}}"}),
    );
    support::historical(&mut cassette);
    let setup = Setup::new("RULES-FAILURE")?
        .fixture(Fixture::Empty)
        .stub_cassette(cassette);
    let mut s = forget::start(setup).await?;
    let output = support::tool(&s, "general", forget::GLOBAL, "update_explicit_memory").await?;
    assert_eq!(output["ok"], true, "{output}");
    let original = support::active_rules(&s.sandbox.data).pop().unwrap();
    s.provider()?
        .add_placeholder("TARGET", original["handle"].as_str().unwrap());
    s.provider()?
        .inject(Fault::first_call(STALE, Transform::StallAfter(0)))?;
    let stalled = accepted_turn_id(&s.gw.say("general", STALE).await?)?;
    support::until(|| {
        s.provider()
            .unwrap()
            .requests()
            .iter()
            .any(|r| r.to_string().contains(STALE))
    })
    .await;
    let other = support::new_chat(&s, "Concurrent correction").await?;
    let output = support::tool(&s, &other, forget::CORRECT, "update_explicit_memory").await?;
    assert_eq!(output["ok"], true, "{output}");
    let root = s.sandbox.data.join("cognition/memory/rules");
    let manifest = std::fs::read(root.join("manifest.json"))?;
    s.agent.kill9()?;
    s.restart().await?;
    let turn =
        s.gw.wait_terminal("general", &stalled, Duration::from_secs(90))
            .await?;
    assert_eq!(turn["safe_error_code"], "turn_interrupted", "{turn}");
    let retry =
        s.gw.post(&format!("/turns/{stalled}/retry"), json!({}))
            .await?;
    assert_eq!(retry.status, 202, "{}", retry.text);
    let turn =
        s.gw.wait_terminal("general", &stalled, Duration::from_secs(90))
            .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let output = support::result(&s, "general", &stalled, "update_explicit_memory").await?;
    assert_eq!(output["ok"], false, "{output}");
    assert_eq!(
        output["error"]["message"], "rule_revision_stale",
        "{output}"
    );
    assert_eq!(std::fs::read(root.join("manifest.json"))?, manifest);
    assert_eq!(std::fs::read_dir(root.join("operations"))?.count(), 2);
    // Fail a real index read after durable intent/source/archive/exclusion, then recover it.
    std::fs::rename(root.join("INDEX.md"), root.join("index-before-failure"))?;
    std::fs::create_dir(root.join("INDEX.md"))?;
    let output = support::tool(&s, &other, forget::CORRECT, "update_explicit_memory").await?;
    assert_eq!(output["ok"], false, "{output}");
    assert_eq!(
        output["error"]["message"],
        "Rule change is pending recovery."
    );
    assert!(root.join("pending.json").exists());
    let section = support::active_section(&s, "general", forget::ASK).await?;
    assert!(!section.contains("5400") && !section.contains("6401") && !section.contains("7400"));
    std::fs::remove_dir(root.join("INDEX.md"))?;
    std::fs::rename(root.join("index-before-failure"), root.join("INDEX.md"))?;
    s.restart().await?;
    support::until(|| !root.join("pending.json").exists()).await;
    let section = support::active_section(&s, "general", forget::ASK).await?;
    assert!(section.contains("6401") && !section.contains("5400") && !section.contains("7400"));
    assert_eq!(support::active_rules(&s.sandbox.data).len(), 1);
    let binding = support::read_json(&root.join(format!(
        "{}.source.json",
        original["record_id"].as_str().unwrap()
    )))
    .unwrap();
    assert_eq!(binding["operations"].as_array().unwrap().len(), 3);
    assert_eq!(std::fs::read_dir(root.join("operations"))?.count(), 3);
    eprintln!("RULES-FAILURE stale_writes=0 io_failure_pending=true recovered_once=true");
    s.finish().await?;
    Ok(())
}
