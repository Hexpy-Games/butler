//! Local time from the zone rules Windows reads (the archive embedded in the
//! executable): every embedded zone, the new-chat briefing (also of a fresh
//! profile on its host zone) and schedules.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Fixture, Setup},
};
use butler_platform::time_zone;
use serde_json::json;

/// Past, present and far-future instants, in seconds since the epoch.
fn instants() -> Vec<i64> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_secs()).unwrap())
        .unwrap();
    // 1901, 1970, 2001, now, 2027, 2038 (past i32), 2100 and 2200.
    vec![
        -2_147_000_000,
        0,
        1_000_000_000,
        now,
        1_800_000_000,
        2_200_000_000,
        4_102_444_800,
        7_258_118_400,
    ]
}

/// Every embedded zone, aliases included, has a local time type at every
/// instant, also after its last transition (zones without DST end their
/// transitions decades ago). Where the host has its own rules (zoneinfo on
/// Unix), the UTC offset agrees with them at the present instant.
// test-category: pure-logic
#[test]
fn every_embedded_zone_resolves_local_time_at_any_instant() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let names = time_zone::baseline_zone_names()?;
    assert!(names.len() > 600, "{}", names.len());
    let mut failures = Vec::new();
    let mut compared = 0;
    for name in &names {
        let zone = tz::TimeZone::from_tz_data(&time_zone::baseline_zone_rules(name)?)
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        for instant in instants() {
            if let Err(error) = zone.find_local_time_type(instant) {
                failures.push(format!("{name} at {instant}: {error}"));
            }
        }
        let Some(host) = time_zone::zone_rules(name)
            .ok()
            .and_then(|bytes| tz::TimeZone::from_tz_data(&bytes).ok())
        else {
            continue;
        };
        compared += 1;
        let now = instants()[3];
        let offset = |zone: &tz::TimeZone| {
            zone.find_local_time_type(now)
                .map(tz::LocalTimeType::ut_offset)
        };
        if offset(&zone).ok() != offset(&host).ok() {
            failures.push(format!(
                "{name}: embedded {:?}, host {:?}",
                offset(&zone),
                offset(&host)
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    eprintln!("zones={} host-compared={compared}", names.len());
    Ok(())
}

/// A fresh profile on the host's own zone (no TZ override) is offered the
/// first-chat onboarding card.
#[tokio::test]
async fn fresh_profile_on_host_zone_offers_onboarding_card() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("LOCAL-ZONE-ONBOARDING")?
        .fixture(Fixture::FirstConversation)
        .unset_env("TZ")
        .start()
        .await?;
    let briefing = s.gw.get("/new-chat-briefing").await?;
    assert_eq!(briefing.status, 200, "{}", briefing.text);
    assert_eq!(briefing.data()["source"]["scope"], "onboarding");
    let cards = briefing.data()["suggestions"].as_array().unwrap().clone();
    assert_eq!(cards.len(), 1, "{cards:?}");
    assert_eq!(cards[0]["id"], "butler-onboarding");
    s.finish().await
}

/// A zone without DST whose last transition is decades old (1988) gives the
/// briefing its local moment: on Windows its rules come from the embedded
/// archive.
#[tokio::test]
async fn zone_without_dst_gives_the_briefing_its_local_moment() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("LOCAL-ZONE-MOMENT")?
        .fixture(Fixture::Ready)
        .env("TZ", "Asia/Seoul")
        .env("BUTLER_E2E_APP_NOW", "2026-09-27T00:30:00Z")
        .start()
        .await?;
    let briefing = s.gw.get("/new-chat-briefing").await?;
    assert_eq!(briefing.status, 200, "{}", briefing.text);
    assert_eq!(briefing.data()["source"]["scope"], "general");
    assert_eq!(briefing.data()["moment"], "9:30 AM");
    s.finish().await
}

/// A daily schedule in a zone without DST gets its next run from the same
/// rules.
#[tokio::test]
async fn schedule_in_zone_without_dst_gets_its_next_run() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("LOCAL-ZONE-SCHEDULE")?
        .env("BUTLER_E2E_APP_NOW", "2026-09-27T00:30:00.000Z")
        .start()
        .await?;
    let rule = json!({"kind":"daily","time":"08:00","tz":"Asia/Seoul","weekdays":[]});
    let created =
        s.gw.post(
            "/automations",
            json!({"id":"daily-eight","title":"Brief","prompt_body":"Brief me",
                "target_session_id":"general","schedule":rule}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    assert_eq!(
        created.data()["automation"]["next_run_at"],
        "2026-09-27T23:00:00.000Z"
    );
    s.finish().await
}
