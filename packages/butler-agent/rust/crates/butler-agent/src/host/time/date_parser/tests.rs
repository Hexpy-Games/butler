use super::DateParser;

/// Pure-logic table: local time zones. Local times resolve through DST gaps
/// and overlaps like JavaScript, maintenance uses the process-local day, the
/// prompt clock formats local time with zone names, and unknown zones are
/// rejected.
// test-category: pure-logic
#[test]
fn local_time_zones_resolve_like_javascript() {
    local_times_resolve_through_dst_gaps_and_overlaps_like_javascript();
    maintenance_uses_process_local_day_and_rejects_unknown_zones();
    daily_ticks_follow_calendar_boundaries();
    crate::host::time::prompt_clock::tests::prompt_clock_formats_local_time_with_zone_names_and_rejects_unknown_zones();
}

fn local_times_resolve_through_dst_gaps_and_overlaps_like_javascript() {
    // Gaps move forward, overlaps take the earlier offset, explicit offsets win.
    for (zone, text, expected) in [
        (
            "America/New_York",
            "2024-03-10T01:59:00.123",
            1_710_053_940_123,
        ),
        (
            "America/New_York",
            "2024-03-10T02:30:00.123",
            1_710_055_800_123,
        ),
        (
            "America/New_York",
            "2024-11-03T01:30:00.123",
            1_730_611_800_123,
        ),
        (
            "America/New_York",
            "2024-11-03T02:00:00.123",
            1_730_617_200_123,
        ),
        ("Europe/Paris", "2024-03-31T02:30:00.123", 1_711_848_600_123),
        ("Asia/Seoul", "January 1 2024 12:00", 1_704_078_000_000),
        ("UTC", "2024-02-03T04:05:06.123+09:00", 1_706_900_706_123),
        ("Asia/Seoul", "1970-01-01", 0),
        ("Pacific/Apia", "2024-02-30 12:00", 1_709_247_600_000),
    ] {
        let parser = DateParser::new(zone).unwrap();
        assert_eq!(parser.parse(text), Some(expected), "{zone} {text}");
    }
}

fn maintenance_uses_process_local_day_and_rejects_unknown_zones() {
    {
        assert!(DateParser::new("bad-zone").is_err());
    }
    {
        let zone = DateParser::new("Asia/Seoul").unwrap();
        let instant = chrono::DateTime::parse_from_rfc3339("2026-09-22T18:30:00Z").unwrap();
        assert_eq!(
            zone.local_day_and_minute(instant.timestamp_millis())
                .unwrap(),
            ("2026-09-23".into(), 210)
        );
    }
}

fn daily_ticks_follow_calendar_boundaries() {
    for (zone, instant, seconds) in [
        ("UTC", "2026-09-23T03:29:30Z", 30),
        ("UTC", "2026-09-23T03:30:00Z", 1_800),
        ("UTC", "2026-09-23T03:59:59Z", 1),
        ("UTC", "2026-09-23T04:00:00Z", 72_000),
        ("UTC", "2026-09-23T23:59:59Z", 1),
        ("America/New_York", "2024-03-10T06:59:00Z", 1_860),
        ("America/New_York", "2024-11-03T05:59:00Z", 9_060),
        ("Pacific/Apia", "2011-12-30T09:59:00Z", 60),
    ] {
        let parser = DateParser::new(zone).unwrap();
        let now = chrono::DateTime::parse_from_rfc3339(instant)
            .unwrap()
            .timestamp_millis();
        assert_eq!(
            crate::host::memory_jobs::context_maintenance::next_tick_delay(&parser, now),
            std::time::Duration::from_secs(seconds),
            "{zone} {instant}",
        );
    }
}
