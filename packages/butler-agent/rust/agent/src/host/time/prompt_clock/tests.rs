use super::*;

#[test]
fn prompt_clock_formats_local_time_with_zone_names_and_rejects_unknown_zones() {
    let clock = NativePromptClock::new().unwrap();
    for (timezone, expected) in [
        ("UTC", "Monday, September 14, 2026 at 12:00:00 AM UTC"),
        (
            "America/New_York",
            "Sunday, September 13, 2026 at 8:00:00 PM EDT",
        ),
        (
            "Asia/Seoul",
            "Monday, September 14, 2026 at 9:00:00 AM GMT+9",
        ),
        (
            "Asia/Kolkata",
            "Monday, September 14, 2026 at 5:30:00 AM GMT+5:30",
        ),
    ] {
        assert_eq!(
            clock
                .format_local_time(1_789_344_000_000, timezone)
                .unwrap(),
            expected
        );
    }
    assert!(clock.format_local_time(0, "UTC+9").is_err());
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
