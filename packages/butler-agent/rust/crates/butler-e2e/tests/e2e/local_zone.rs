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

/// Fixed past, present and far-future instants, in seconds since the epoch:
/// 1901, 1970, 2001, 2026-10-29, 2027, 2038 (past i32), 2100 and 2200.
const INSTANTS: [i64; 8] = [
    -2_147_000_000,
    0,
    1_000_000_000,
    1_793_232_000,
    1_800_000_000,
    2_200_000_000,
    4_102_444_800,
    7_258_118_400,
];

/// Every embedded zone, aliases included, has a local time type at every
/// instant, also after its last transition (zones without DST end their
/// transitions decades ago), and its final type has a real designation.
// test-category: pure-logic
#[test]
fn every_embedded_zone_resolves_local_time_at_any_instant() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let zones = time_zone::baseline_zones()?;
    assert!(zones.len() > 600, "{}", zones.len());
    let mut failures = Vec::new();
    for entry in &zones {
        let name = entry.name;
        let zone = tz::TimeZone::from_tz_data(entry.rules)
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        for instant in INSTANTS {
            match zone.find_local_time_type(instant) {
                Err(error) => failures.push(format!("{name} at {instant}: {error}")),
                Ok(local) if instant == INSTANTS[7] && local.time_zone_designation() == "LMT" => {
                    failures.push(format!("{name}: final designation LMT"));
                }
                Ok(_) => {}
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    Ok(())
}

/// UTC offsets of the rules Windows reads, pinned from IANA tzdata 2026e
/// (the archive's release) at 2026-01-15, 2026-07-15, 2027-01-15 and
/// 2040-07-15 12:00 UTC: zones without DST, with DST in either hemisphere,
/// half-hour and 45-minute offsets and DST, +13/+14, an alias, and zones
/// whose rules changed in 2026 (permanent DST, Morocco).
// test-category: pure-logic
#[test]
fn embedded_rules_give_the_expected_offsets() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    const AT: [i64; 4] = [1_768_478_400, 1_784_116_800, 1_800_014_400, 2_225_966_400];
    let expected: [(&str, [i32; 4]); 17] = [
        ("UTC", [0, 0, 0, 0]),
        ("Etc/GMT+5", [-18000, -18000, -18000, -18000]),
        ("Asia/Seoul", [32400, 32400, 32400, 32400]),
        ("Asia/Calcutta", [19800, 19800, 19800, 19800]),
        ("Asia/Kathmandu", [20700, 20700, 20700, 20700]),
        ("America/New_York", [-18000, -14400, -18000, -14400]),
        ("Europe/London", [0, 3600, 0, 3600]),
        ("Australia/Sydney", [39600, 36000, 39600, 36000]),
        ("Australia/Lord_Howe", [39600, 37800, 39600, 37800]),
        ("Pacific/Chatham", [49500, 45900, 49500, 45900]),
        ("Pacific/Tongatapu", [46800, 46800, 46800, 46800]),
        ("Pacific/Kiritimati", [50400, 50400, 50400, 50400]),
        ("America/Sao_Paulo", [-10800, -10800, -10800, -10800]),
        ("Africa/Casablanca", [3600, 3600, 0, 0]),
        ("America/Vancouver", [-28800, -25200, -25200, -25200]),
        ("America/Winnipeg", [-21600, -18000, -18000, -18000]),
        ("America/Inuvik", [-25200, -21600, -21600, -21600]),
    ];
    for (name, offsets) in expected {
        let zone = tz::TimeZone::from_tz_data(&time_zone::baseline_zone_rules(name)?)
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        let actual = AT.map(|instant| {
            zone.find_local_time_type(instant)
                .map(tz::LocalTimeType::ut_offset)
                .unwrap_or_else(|error| panic!("{name} at {instant}: {error}"))
        });
        assert_eq!(actual, offsets, "{name}");
    }
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
