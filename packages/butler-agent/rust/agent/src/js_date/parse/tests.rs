use super::parse_date_millis;

#[test]
fn grammar_and_local_boundary_match_actual_bun_fixed_zone_corpus() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!("source-bun.json")).unwrap();
    let mut failures = Vec::new();
    for zone in fixture["zones"].as_array().unwrap() {
        let offset = zone["offset_seconds"].as_i64().unwrap() * 1000;
        for case in zone["cases"].as_array().unwrap() {
            let text = case[0].as_str().unwrap();
            let expected = case[1].as_i64();
            let actual = parse_date_millis(text, &|local| local.checked_sub(offset));
            if actual != expected {
                failures.push((zone["zone"].clone(), text.to_owned(), expected, actual));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} mismatches; first 20: {:?}",
        failures.len(),
        failures.iter().take(20).collect::<Vec<_>>()
    );
}

#[test]
fn utc_dates_do_not_consult_local_conversion_and_invalid_host_output_is_rejected() {
    assert_eq!(
        parse_date_millis("1970-01-01", &|_| panic!("date only is UTC")),
        Some(0)
    );
    assert_eq!(
        parse_date_millis("1970-01-01T00:00:00Z", &|_| panic!("explicit UTC")),
        Some(0)
    );
    assert_eq!(parse_date_millis("1970-01-01T00:00:00", &|_| None), None);
    assert_eq!(
        parse_date_millis("1970-01-01T00:00:00", &|_| Some(i64::MIN)),
        None
    );
}
