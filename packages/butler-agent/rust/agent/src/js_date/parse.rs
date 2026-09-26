//! Borrowed-input Date.parse grammar, with host-local time conversion injected.
//! Adapted from Bun's BSD-licensed JSDateMath-v8 parser; see parse/LICENSE.txt.
//! No engine, timezone cache, retained date strings, or per-token heap exists.

mod iso;
mod parts;
mod token;

use parts::{Day, Time, Zone};
use token::{Kind, Scanner, Token};

/// `local_to_utc` receives wall-clock components encoded as epoch milliseconds.
/// The host owns the process timezone and DST ambiguity/nonexistence policy.
pub(crate) fn parse_date_millis(
    value: &str,
    local_to_utc: &dyn Fn(i64) -> Option<i64>,
) -> Option<i64> {
    let mut scanner = Scanner::new(value);
    let (mut day, mut time, mut zone) = (Day::default(), Time::default(), Zone::default());
    let mut token = iso::parse(&mut scanner, &mut day, &mut time, &mut zone)?;
    let mut has_number = day.count != 0;
    while token.kind != Kind::End {
        if let Some(number) = token.number() {
            has_number = true;
            legacy_number(number, &mut scanner, &mut day, &mut time, &mut zone)?;
        } else {
            match token.kind {
                Kind::AmPm if time.count != 0 => time.hour_offset = Some(token.value),
                Kind::Month => {
                    day.month = Some(token.value);
                    scanner.symbol(b'-');
                }
                Kind::Zone if has_number => zone.set(token.value),
                Kind::AmPm | Kind::Zone | Kind::Separator | Kind::Word => {
                    if has_number || scanner.peek.kind == Kind::Number {
                        return None;
                    }
                }
                _ if token.sign().is_some() && (zone.utc() || time.count != 0) => {
                    legacy_zone(token, &mut scanner, &mut zone)?;
                    has_number = true;
                }
                _ if has_number && (token.sign().is_some() || token.kind == Kind::Symbol(b')')) => {
                    return None;
                }
                _ => {}
            }
        }
        token = scanner.next();
    }
    let (year, month, day) = day.finish()?;
    let mut millis =
        super::days_from_civil(year, month, day) * super::MILLIS_PER_DAY + time.finish()?;
    match zone.finish()? {
        Some(offset) => millis -= offset * 1000,
        None => {
            if millis.abs() > super::TIME_CLIP + 30 * super::MILLIS_PER_DAY {
                return None;
            }
            millis = local_to_utc(millis)?;
        }
    }
    (millis.unsigned_abs() <= super::TIME_CLIP as u64).then_some(millis)
}

fn legacy_number(
    number: i64,
    scanner: &mut Scanner<'_>,
    day: &mut Day,
    time: &mut Time,
    zone: &mut Zone,
) -> Option<()> {
    if scanner.symbol(b':') {
        if scanner.symbol(b':') {
            if time.count != 0 {
                return None;
            }
            time.add(number)?;
            time.add(0)?;
        } else {
            time.add(number)?;
            scanner.symbol(b'.');
        }
    } else if scanner.symbol(b'.') && time.expecting(number) {
        time.add(number)?;
        let token = scanner.next();
        token.number()?;
        time.final_value(token.milliseconds())?;
    } else if zone.expecting(number) {
        zone.minute = Some(number);
    } else if time.expecting(number) {
        time.final_value(number)?;
        if !matches!(scanner.peek.kind, Kind::End | Kind::Space)
            && !scanner.peek.z()
            && scanner.peek.sign().is_none()
        {
            return None;
        }
    } else {
        day.add(number)?;
        scanner.symbol(b'-');
    }
    Some(())
}

fn legacy_zone(token: Token, scanner: &mut Scanner<'_>, zone: &mut Zone) -> Option<()> {
    zone.sign = token.sign();
    let (number, length) = if scanner.peek.kind == Kind::Number {
        let next = scanner.next();
        (next.value, next.length)
    } else {
        (0, 0)
    };
    if scanner.peek.kind == Kind::Symbol(b':') {
        zone.hour = Some(number);
        zone.minute = None;
    } else if matches!(length, 1 | 2) {
        zone.hour = Some(number);
        zone.minute = Some(0);
    } else if matches!(length, 3 | 4) {
        zone.hour = Some(number / 100);
        zone.minute = Some(number % 100);
    } else {
        return None;
    }
    Some(())
}

#[cfg(test)]
mod tests;
