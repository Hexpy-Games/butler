use super::*;

pub(crate) fn prompt_clock_formats_local_time_with_zone_names_and_rejects_unknown_zones() {
    let clock = SystemPromptClock::new().unwrap();
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
