use super::*;

#[derive(serde::Deserialize)]
struct Golden {
    icu: String,
    cases: Vec<Case>,
}

#[derive(serde::Deserialize)]
struct Case {
    timezone: String,
    epoch: i64,
    expected: Option<String>,
}

#[test]
fn native_prompt_clock_matches_bun_timezone_and_calendar_fixture() {
    let fixture: Golden = serde_json::from_str(include_str!("bun-golden.json")).unwrap();
    check_golden(fixture);
}

#[test]
fn native_prompt_clock_matches_every_icu_alias_acceptance() {
    let fixture: Golden = serde_json::from_str(include_str!("bun-alias-golden.json")).unwrap();
    assert_eq!(fixture.cases.len(), 639);
    check_golden(fixture);
}

fn check_golden(fixture: Golden) {
    assert_eq!(fixture.icu, "74.2");
    let owner = NativePromptClock::new().unwrap();
    let mut failures = Vec::new();
    for case in &fixture.cases {
        let actual = owner.format_local_time(case.epoch, &case.timezone).ok();
        if actual != case.expected {
            failures.push(format!(
                "{} {}\nexpected: {:?}\nactual: {:?}",
                case.timezone, case.epoch, case.expected, actual
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n{}",
        failures.len(),
        fixture.cases.len(),
        failures
            .iter()
            .take(8000)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn prompt_clock_native_iso_preserves_range_and_rejects_invalid_timestamp() {
    let clock = NativePromptClock::new().unwrap();
    let epoch = 1_789_344_000_000;
    assert_eq!(
        clock.parse_timestamp("2026-09-14T00:00:00.000Z"),
        Some(epoch)
    );
    assert_eq!(
        clock.iso_from_epoch_millis(epoch).unwrap(),
        "2026-09-14T00:00:00.000Z"
    );
    assert!(clock.iso_from_epoch_millis(8_640_000_000_000_001).is_err());
    assert!(
        clock
            .format_local_time(8_640_000_000_000_001, "UTC")
            .is_err()
    );
    assert_eq!(clock.parse_timestamp("not a timestamp"), None);
}
