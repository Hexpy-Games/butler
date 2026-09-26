use super::NativeDateParser;

#[test]
fn local_times_resolve_through_dst_gaps_and_overlaps_like_javascript() {
    // Gaps move forward, overlaps take the earlier offset, explicit offsets win.
    for (zone, text, expected) in [
        ("America/New_York", "2024-03-10T01:59:00.123", 1710053940123),
        ("America/New_York", "2024-03-10T02:30:00.123", 1710055800123),
        ("America/New_York", "2024-11-03T01:30:00.123", 1730611800123),
        ("America/New_York", "2024-11-03T02:00:00.123", 1730617200123),
        ("Europe/Paris", "2024-03-31T02:30:00.123", 1711848600123),
        ("Asia/Seoul", "January 1 2024 12:00", 1704078000000),
        ("UTC", "2024-02-03T04:05:06.123+09:00", 1706900706123),
        ("Asia/Seoul", "1970-01-01", 0),
        ("Pacific/Apia", "2024-02-30 12:00", 1709247600000),
    ] {
        let parser = NativeDateParser::new(zone).unwrap();
        assert_eq!(parser.parse(text), Some(expected), "{zone} {text}");
    }
}

#[test]
fn maintenance_uses_process_local_day_and_rejects_unknown_zones() {
    {
        assert!(NativeDateParser::new("bad-zone").is_err());
    }
    {
        let zone = NativeDateParser::new("Asia/Seoul").unwrap();
        let instant = chrono::DateTime::parse_from_rfc3339("2026-09-22T18:30:00Z").unwrap();
        assert_eq!(
            zone.local_day_and_minute(instant.timestamp_millis())
                .unwrap(),
            ("2026-09-23".into(), 210)
        );
    }
}
