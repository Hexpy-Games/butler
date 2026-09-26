use super::parse_date_millis;

#[test]
fn date_grammar_resolves_utc_and_local_forms_and_rejects_invalid_dates() {
    // (text, parsed in UTC, parsed in a fixed UTC+09:00 zone)
    for (text, utc, plus_nine) in [
        ("2000-04-31", Some(957139200000), Some(957139200000)),
        ("2024-02-30 1:2", Some(1709254920000), Some(1709222520000)),
        (
            "2024-02-30 1:2+09",
            Some(1709222520000),
            Some(1709222520000),
        ),
        (
            "Mar 30 1999 12:34 GMT-0800",
            Some(922826040000),
            Some(922826040000),
        ),
        (
            "1900-02-29T12:34:56Z",
            Some(-2203845904000),
            Some(-2203845904000),
        ),
        (
            "+010000-01-01T01:02:03.123456789999",
            Some(253402304523123),
            Some(253402272123123),
        ),
        ("Jan 1 50", Some(-631152000000), Some(-631184400000)),
        ("Dec 29 49", Some(2524348800000), Some(2524316400000)),
        ("2024-13-01T24:00:00-00:30", None, None),
        ("January 32 1999 12::34 GMT+9", None, None),
        ("19700131", None, None),
        (
            "+275760-09-13T00:00:00Z",
            Some(8640000000000000),
            Some(8640000000000000),
        ),
    ] {
        for (offset, expected) in [(0, utc), (9 * 3_600_000, plus_nine)] {
            assert_eq!(
                parse_date_millis(text, &|local| local.checked_sub(offset)),
                expected,
                "{text} at offset {offset}"
            );
        }
    }
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
