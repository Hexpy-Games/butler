//! SS6: result turns, durable holds, exact unattended attention and inherited tiers.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Access, Scenario, Setup},
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
mod delivery;
mod failures;
mod quiet;
mod recovery;
mod schedule_tier;
pub(crate) mod stub;
mod tier;
mod unattended;
use crate::chats_initiated::support::clock;

pub(crate) async fn setup(name: &str, url: &str) -> Result<(Scenario, String), HarnessError> {
    setup_with_failures(name, url, "0").await
}

async fn setup_with_failures(
    name: &str,
    url: &str,
    failures: &str,
) -> Result<(Scenario, String), HarnessError> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let address = listener.local_addr()?.to_string();
    drop(listener);
    let setup = Setup::new(name)?
        .cassette("TOOL-01")
        .access(Access::FullAccess)
        .env("TZ", "UTC")
        .env("BUTLER_E2E_WORK_SEND_FAILURES", failures)
        .env("BUTLER_E2E_APP_NOW", "2026-10-27T12:00:00.000Z")
        .env("BUTLER_E2E_APP_CLOCK_ADDRESS", &address)
        .env("BUTLER_CHATGPT_API_BASE_URL", url);
    crate::memory_fixture::initialize_empty(&setup.sandbox.data)?;
    std::fs::write(
        setup.sandbox.data.join("report.md"),
        "# Evidence\nComplete evidence document.\n",
    )?;
    let s = setup.start().await?;
    s.patch_settings(json!({"timezone":"UTC","language":"ko"}), "locale")
        .await?;
    Ok((s, address))
}

pub(crate) fn runtime(s: &Scenario) -> Result<rusqlite::Connection, HarnessError> {
    Ok(rusqlite::Connection::open(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
    )?)
}
pub(crate) fn app(s: &Scenario) -> Result<rusqlite::Connection, HarnessError> {
    Ok(rusqlite::Connection::open(
        s.sandbox.data.join("app-server/butler-client.sqlite"),
    )?)
}
pub(crate) async fn wait_count(
    s: &Scenario,
    kind: &str,
    count: usize,
) -> Result<Vec<Value>, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let messages: Vec<_> =
            s.gw.messages("general")
                .await?
                .into_iter()
                .filter(|m| m["initiated"]["kind"] == kind && m["status"] == "delivered")
                .collect();
        if messages.len() >= count {
            assert_eq!(messages.len(), count);
            return Ok(messages);
        }
        assert!(
            Instant::now() < deadline,
            "missing {kind}: {messages:?}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
pub(crate) async fn held(s: &Scenario, kind: &str, count: i64) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let n: i64 = app(s)?.query_row(
            "SELECT count(*) FROM app_initiated_messages WHERE kind=?1 AND state='held'",
            [kind],
            |r| r.get(0),
        )?;
        if n == count {
            return Ok(());
        }
        assert!(
            Instant::now() < deadline,
            "held {kind}: {n}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn completion(hold: &str, restart: bool) -> Result<(), HarnessError> {
    let (url, script, server) = stub::start(false, true).await?;
    let (mut s, address) = setup("SS6-WORK", &url).await?;
    let turn = s.gw.say_turn("general", "Prepare evidence.").await?;
    tokio::time::timeout(Duration::from_secs(30), script.held.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    s.gw.wait_terminal("general", &turn, Duration::from_secs(30))
        .await?;
    let before = s.gw.messages("general").await?;
    assert_eq!(
        before.iter().filter(|m| m["role"] == "assistant").count(),
        1
    );
    let (relation, child, title): (String, String, String) = runtime(&s)?.query_row(
        "SELECT relation_id,child_session_id,safe_title FROM btcc_session_relations",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    if hold == "typing" {
        assert_eq!(
            s.gw.post("/sessions/general/composing", json!({}))
                .await?
                .status,
            200
        );
    } else if hold == "quiet" {
        clock(&address, "2026-10-28T06:59:59.000Z").await?;
    }
    script.release.add_permits(1);
    if hold == "typing" {
        held(&s, "work_result", 1).await?;
        assert_eq!(s.gw.messages("general").await?, before);
        clock(&address, "2026-10-28T12:00:00.000Z").await?;
    }
    let messages = wait_count(&s, "work_result", 1).await?;
    let result = &messages[0];
    let status: String = runtime(&s)?.query_row(
        "SELECT status FROM btcc_steward_results WHERE relation_id=?1",
        [&relation],
        |r| r.get(0),
    )?;
    assert_eq!(status, "success");
    assert_eq!(
        result["initiated"],
        json!({"kind":"work_result","quiet":hold == "quiet","relation_id":relation,"work_session_id":child,"work_title":title})
    );
    // Omitted when false: absent and false are the same contract value.
    assert_eq!(result["quiet"].as_bool().unwrap_or(false), hold == "quiet");
    assert!(result.to_string().contains("report.md"), "{result}");
    assert_eq!(
        s.gw.messages("general")
            .await?
            .iter()
            .filter(|m| m["role"] == "assistant")
            .count(),
        2
    );
    assert_eq!(
        s.gw.get(&format!("/session-view?session_id={child}"))
            .await?
            .status,
        200
    );
    assert!(
        s.gw.events_since(0)
            .await?
            .iter()
            .any(|e| e["payload"]["message"]["initiated"] == result["initiated"])
    );
    if restart {
        s.agent
            .launch
            .set_env("BUTLER_E2E_APP_NOW", "2026-10-28T06:59:59.000Z");
        s.crash_and_restart().await?;
        assert_eq!(
            wait_count(&s, "work_result", 1).await?[0]["initiated"],
            result["initiated"]
        );
    }
    s.finish().await?;
    server.abort();
    Ok(())
}
#[tokio::test]
async fn work_result_has_document_and_observer_link_once() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    completion("", false).await
}
#[tokio::test]
async fn composing_holds_work_result() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    completion("typing", false).await
}
#[tokio::test]
async fn user_work_result_in_quiet_hours_is_delivered_and_stays_quiet_after_restart()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    completion("quiet", true).await
}
