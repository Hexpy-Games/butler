# 10. Schedule UX for non-technical users (#234, P1, after 09)

**Start from:** `origin/main` after plan 09 has merged. Issue #234 has the evidence.

## Steps
1. **Time-of-day schedules.** Add daily, weekdays and weekly at a chosen time in the local time zone, alongside intervals.
   - API: extend the schedule record. Suggested shape: `schedule: {kind: interval|daily|weekly, time, weekdays, tz}`. Fix `contracts.rs:5-10` and `store.rs:66-69`.
   - The next run is computed from the rule. Today it is creation time + interval.
   - The time-zone code goes through `butler_platform::time_zone`.
2. **List view.** Show a human, localized summary such as "매일 오전 8시" or "Every day at 8:00 AM", plus the next run time. Replace the raw `state / interval_label`.
   - Rust must not build English-only labels (`records.rs:193-202`). Send structured fields and let the UI localize them.
3. **Quit and login behavior.**
   - The quit dialog (`app-foreground-quit.mjs`) is localized through i18n and says "예약 작업" / "schedules". It uses the terse copy rule.
   - "Start at login" becomes a Settings toggle, not just a tray item.
   - When a schedule exists and start-at-login is off, show a brief one-time hint. No banner.
4. **Terminology.** Rename the remaining "자동화" / "Automations" strings in `packages/butler-i18n/src/locales/{ko,en}.ts` (list in #234) to "예약 작업" / "Schedules".
5. **Form.** Localize the interval options (`AutomationForm.tsx:95-101`) and add the time picker.

## Acceptance
- E2E: create "every day at 08:00". The next run is today or tomorrow at 08:00 local time; across a DST boundary it is correct for the tz.
- The list API returns structured fields.
- Tests: no UI unit tests. Use a harness or smoke test for the form only if it proves behavior. The owner reviews the UI through the live preview.
- A grep of the locale files for "자동화" and "Automation" returns nothing, except in migration notes.
