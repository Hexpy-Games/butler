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
    if let Some(sign) = scanner.peek.sign() {
        let token = scanner.next();
        if !scanner.peek.fixed(6, 0, 999_999) {
            return Some(token);
        }
        let year = scanner.next().value;
        if sign < 0 && year == 0 {
            return Some(token);
        }
        day.add(sign * year)?;
    } else if scanner.peek.fixed(4, 0, 9999) {
        day.add(scanner.next().value)?;
    } else {
        return Some(scanner.next());
    }
    if scanner.symbol(b'-') {
        if !scanner.peek.fixed(2, 1, 12) {
            return Some(scanner.next());
        }
        day.add(scanner.next().value)?;
        if scanner.symbol(b'-') {
            if !scanner.peek.fixed(2, 1, 31) {
                return Some(scanner.next());
            }
            day.add(scanner.next().value)?;
        }
    }
    if scanner.peek.kind != Kind::Separator {
        if scanner.peek.kind != Kind::End {
            return Some(scanner.next());
        }
    } else {
        scanner.next();
        if !scanner.peek.fixed(2, 0, 24) {
            return None;
        }
        let last_hour = scanner.peek.value == 24;
        time.add(scanner.next().value)?;
        if !scanner.symbol(b':') || !scanner.peek.fixed(2, 0, if last_hour { 0 } else { 59 }) {
            return None;
        }
        time.add(scanner.next().value)?;
        if scanner.symbol(b':') {
            if !scanner.peek.fixed(2, 0, if last_hour { 0 } else { 59 }) {
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
        }
        if scanner.peek.z() {
            scanner.next();
            zone.set(0);
        } else if let Some(sign) = scanner.peek.sign() {
            scanner.next();
            zone.sign = Some(sign);
            if scanner.peek.fixed(4, 0, 9999) {
                let value = scanner.next().value;
                if value / 100 > 23 || value % 100 > 59 {
                    return None;
                }
                zone.hour = Some(value / 100);
                zone.minute = Some(value % 100);
            } else {
                if !scanner.peek.fixed(2, 0, 23) {
                    return None;
                }
                zone.hour = Some(scanner.next().value);
                if !scanner.symbol(b':') || !scanner.peek.fixed(2, 0, 59) {
                    return None;
                }
                zone.minute = Some(scanner.next().value);
            }
        }
        if scanner.peek.kind != Kind::End {
            return None;
        }
    }
    if zone.hour.is_none() && time.count == 0 {
        zone.set(0);
    }
    day.iso = true;
    Some(scanner.peek)
}
