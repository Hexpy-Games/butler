//! A schedule's read: its signed-in switch comes first, ahead of the grants and
//! of the loopback reach a chat's read has.
use super::{ACCOUNT, Host, assert_no_secrets, cassette, model_text, read, results, turn};
use butler_e2e::e2e::{
    HarnessError,
    gateway::turn_state,
    scenario::{Scenario, Setup},
};
use serde_json::json;
use std::time::Duration;

const LOCAL: &str = "http://localhost:3000/";
const SWITCH_OFF: &str = "Read with the signed-in switch off";
const SWITCH_ON: &str = "Read with the signed-in switch on";

async fn run_schedule(s: &Scenario, prompt: &str, signin: bool) -> Result<(), HarnessError> {
    let created =
        s.gw.post(
            "/automations",
            json!({"title":prompt,"prompt_body":prompt,"target_session_id":"general",
                "interval_seconds":3600,"browser_signin":signin,"source_session_id":"general"}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let automation = created.data()["automation"]["id"].as_str().unwrap();
    let run =
        s.gw.post(&format!("/automations/{automation}/run"), json!({}))
            .await?;
    assert_eq!(run.status, 202, "{}", run.text);
    let turn = run.data()["run"]["turn_id"].as_str().unwrap().to_owned();
    let done =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(30))
            .await?;
    assert_eq!(turn_state(&done), "delivered", "{done}\n{}", s.agent.logs());
    Ok(())
}

#[tokio::test]
async fn a_schedule_reads_only_with_its_signed_in_switch_on() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let reads = || vec![read("acct", "console"), read("local", "console")];
    let s = Setup::new("BROWSER-DEVTOOLS-SCHEDULE")?
        .stub_cassette(cassette(&[
            turn(SWITCH_OFF, reads()),
            turn(SWITCH_ON, reads()),
        ])?)
        .start()
        .await?;
    let host = Host::attach(
        &s,
        &[
            ("acct", "signed_in", ACCOUNT),
            ("local", "signed_in", LOCAL),
        ],
        Some("bank.test"),
    )
    .await?;

    run_schedule(&s, SWITCH_OFF, false).await?;
    let refused = results(&s)
        .iter()
        .filter(|value| value["reason"] == "schedule_signin_off")
        .count();
    assert_eq!(refused, 2, "the granted site and loopback alike");
    assert_eq!(host.reads().len(), 0, "nothing is read");

    run_schedule(&s, SWITCH_ON, true).await?;
    assert_eq!(host.reads().len(), 2);
    assert_no_secrets(&model_text(&s));
    assert_eq!(s.gw.approval_requests("general").await?.len(), 0);
    s.finish().await
}
