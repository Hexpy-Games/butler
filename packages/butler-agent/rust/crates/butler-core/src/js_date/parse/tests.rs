use super::parse_date_millis;

#[test]
fn date_grammar_resolves_utc_and_local_forms_and_rejects_invalid_dates() {
    // (text, parsed in UTC, parsed in a fixed UTC+09:00 zone)
    for (text, utc, plus_nine) in [
        ("2000-04-31", Some(957_139_200_000), Some(957_139_200_000)),
        (
            "2024-02-30 1:2",
            Some(1_709_254_920_000),
            Some(1_709_222_520_000),
        ),
        (
            "2024-02-30 1:2+09",
            Some(1_709_222_520_000),
            Some(1_709_222_520_000),
        ),
        (
            "Mar 30 1999 12:34 GMT-0800",
            Some(922_826_040_000),
            Some(922_826_040_000),
        ),
        (
            "1900-02-29T12:34:56Z",
            Some(-2_203_845_904_000),
            Some(-2_203_845_904_000),
        ),
        (
            "+010000-01-01T01:02:03.123456789999",
            Some(253_402_304_523_123),
            Some(253_402_272_123_123),
        ),
        ("Jan 1 50", Some(-631_152_000_000), Some(-631_184_400_000)),
        (
            "Dec 29 49",
            Some(2_524_348_800_000),
            Some(2_524_316_400_000),
        ),
        ("2024-13-01T24:00:00-00:30", None, None),
        ("January 32 1999 12::34 GMT+9", None, None),
        ("19700131", None, None),
        (
            "+275760-09-13T00:00:00Z",
            Some(8_640_000_000_000_000),
            Some(8_640_000_000_000_000),
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
