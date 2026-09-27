// Adapted from Bun's BSD-licensed JSDateMath-v8 parser. See LICENSE.txt.

use super::parts::{Day, Time, Zone};
use super::token::{Kind, Scanner, Token};

/// Some(token) continues the legacy grammar from the consumed ISO prefix;
/// None is a terminal invalid ISO time. An End token marks completed ISO.
pub(super) fn parse(
    scanner: &mut Scanner<'_>,
    day: &mut Day,
    time: &mut Time,
    zone: &mut Zone,
) -> Option<Token> {
    if let Step::Legacy(token) = date(scanner, day)? {
        return Some(token);
    }
    if scanner.peek.kind == Kind::Separator {
        scanner.next();
        clock_time(scanner, time)?;
        offset(scanner, zone)?;
        if scanner.peek.kind != Kind::End {
            return None;
        }
    } else if scanner.peek.kind != Kind::End {
        return Some(scanner.next());
    }
    if zone.hour.is_none() && time.count == 0 {
        zone.set(0);
    }
    day.iso = true;
    Some(scanner.peek)
}

/// How an ISO date prefix ends.
enum Step {
    /// The ISO grammar continues.
    Next,
    /// The input is not ISO past this point; the legacy grammar resumes here.
    Legacy(Token),
}

/// `YYYY`, `±YYYYYY` (no negative zero), then optional `-MM` and `-DD`.
fn date(scanner: &mut Scanner<'_>, day: &mut Day) -> Option<Step> {
    if let Some(sign) = scanner.peek.sign() {
        let token = scanner.next();
        if !scanner.peek.fixed(6, 0, 999_999) {
            return Some(Step::Legacy(token));
        }
        let year = scanner.next().value;
        if sign < 0 && year == 0 {
            return Some(Step::Legacy(token));
        }
        day.add(sign * year)?;
    } else if scanner.peek.fixed(4, 0, 9999) {
        day.add(scanner.next().value)?;
    } else {
        return Some(Step::Legacy(scanner.next()));
    }
    for maximum in [12, 31] {
        if !scanner.symbol(b'-') {
            break;
        }
        if !scanner.peek.fixed(2, 1, maximum) {
            return Some(Step::Legacy(scanner.next()));
        }
        day.add(scanner.next().value)?;
    }
    Some(Step::Next)
}

/// `HH:mm[:ss[.sss]]`; hour 24 only as `24:00[:00[.000]]`.
fn clock_time(scanner: &mut Scanner<'_>, time: &mut Time) -> Option<()> {
    if !scanner.peek.fixed(2, 0, 24) {
        return None;
    }
    let last_hour = scanner.peek.value == 24;
    let minute_max = if last_hour { 0 } else { 59 };
    time.add(scanner.next().value)?;
    if !scanner.symbol(b':') || !scanner.peek.fixed(2, 0, minute_max) {
        return None;
    }
    time.add(scanner.next().value)?;
    if !scanner.symbol(b':') {
        return Some(());
    }
    if !scanner.peek.fixed(2, 0, minute_max) {
        return None;
    }
    time.add(scanner.next().value)?;
    if scanner.symbol(b'.') {
        let token = scanner.next();
        if token.number().is_none() || (last_hour && token.value > 0) {
            return None;
        }
        time.add(token.milliseconds())?;
    }
    Some(())
}

/// An optional `Z`, `±HHmm` or `±HH:mm` offset.
fn offset(scanner: &mut Scanner<'_>, zone: &mut Zone) -> Option<()> {
    if scanner.peek.z() {
        scanner.next();
        zone.set(0);
        return Some(());
    }
    let Some(sign) = scanner.peek.sign() else {
        return Some(());
    };
    scanner.next();
    zone.sign = Some(sign);
    if scanner.peek.fixed(4, 0, 9999) {
        let value = scanner.next().value;
        if value / 100 > 23 || value % 100 > 59 {
            return None;
        }
        zone.hour = Some(value / 100);
        zone.minute = Some(value % 100);
        return Some(());
    }
    if !scanner.peek.fixed(2, 0, 23) {
        return None;
    }
    zone.hour = Some(scanner.next().value);
    if !scanner.symbol(b':') || !scanner.peek.fixed(2, 0, 59) {
        return None;
    }
    zone.minute = Some(scanner.next().value);
    Some(())
}
