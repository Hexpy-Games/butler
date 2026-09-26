use super::NativeDateParser;

#[test]
fn local_transitions_and_explicit_offsets_match_actual_bun() {
    let source: serde_json::Value = serde_json::from_str(include_str!("source-bun.json")).unwrap();
    let mut failures = Vec::new();
    for zone in source["zones"].as_array().unwrap() {
        let name = zone["zone"].as_str().unwrap();
        let parser = NativeDateParser::new(name).unwrap();
        for case in zone["cases"].as_array().unwrap() {
            let text = case[0].as_str().unwrap();
            let expected = case[1].as_i64();
            let actual = parser.parse(text);
            if actual != expected {
                failures.push((name, text, expected, actual));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} mismatches: {:?}",
        failures.len(),
        failures.iter().take(30).collect::<Vec<_>>()
    );
}

#[test]
fn invalid_zone_is_not_replaced_by_utc() {
    assert!(NativeDateParser::new("bad-zone").is_err());
}

#[test]
fn maintenance_uses_process_local_day_and_minute() {
    let zone = NativeDateParser::new("Asia/Seoul").unwrap();
    let instant = chrono::DateTime::parse_from_rfc3339("2026-09-22T18:30:00Z").unwrap();
    assert_eq!(
        zone.local_day_and_minute(instant.timestamp_millis())
            .unwrap(),
        ("2026-09-23".into(), 210)
    );
}
