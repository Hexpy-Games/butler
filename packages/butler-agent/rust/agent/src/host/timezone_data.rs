//! Frozen baseline TZif data, embedded in the executable. Only the immutable
//! name/byte-slice index is retained; one parsed zone belongs to one time read.

use std::cmp::Ordering;

use crate::context::{ContextError, ContextResult};

fn failure(message: impl Into<String>) -> ContextError {
    ContextError::new("prompt_time_format_error", message)
}

const DATA: &[u8] = include_bytes!("../../resources/timezones/source-2026c.btz");

struct Entry {
    name: &'static str,
    canonical: &'static str,
    bytes: &'static [u8],
}

pub(super) struct TimeZoneData {
    entries: Vec<Entry>,
}

impl TimeZoneData {
    pub(super) fn new() -> ContextResult<Self> {
        let mut input = DATA;
        if take(&mut input, 4)? != b"BTZ2" {
            return Err(failure("Invalid embedded time zone header"));
        }
        let count = take_u32(&mut input)? as usize;
        if count > input.len() / 6 {
            return Err(failure("Invalid embedded time zone count"));
        }
        let mut entries: Vec<Entry> = Vec::with_capacity(count);
        for _ in 0..count {
            let name_len = usize::from(take_u16(&mut input)?);
            let canonical_len = usize::from(take_u16(&mut input)?);
            let data_len = take_u32(&mut input)? as usize;
            let name = std::str::from_utf8(take(&mut input, name_len)?)
                .map_err(|error| failure(error.to_string()))?;
            let canonical = std::str::from_utf8(take(&mut input, canonical_len)?)
                .map_err(|error| failure(error.to_string()))?;
            let bytes = take(&mut input, data_len)?;
            if !name.is_ascii()
                || !bytes.starts_with(b"TZif")
                || entries
                    .last()
                    .is_some_and(|prior| compare(prior.name, name) != Ordering::Less)
            {
                return Err(failure("Invalid embedded time zone record"));
            }
            entries.push(Entry {
                name,
                canonical,
                bytes,
            });
        }
        if !input.is_empty() {
            return Err(failure("Unexpected embedded time zone suffix"));
        }
        Ok(Self { entries })
    }

    pub(super) fn find(&self, name: &str) -> ContextResult<tz::TimeZone> {
        let index = self
            .entries
            .binary_search_by(|entry| compare(entry.name, name))
            .map_err(|_| failure("Unknown time zone"))?;
        tz::TimeZone::from_tz_data(self.entries[index].bytes)
            .map_err(|error| failure(error.to_string()))
    }

    pub(super) fn facts(&self, name: &str, epoch: i64) -> ContextResult<(i32, bool, &'static str)> {
        // ICU also exposes legacy short IDs that ECMAScript Intl rejects.
        const ICU_ONLY: &[&str] = &[
            "ACT",
            "AET",
            "AGT",
            "ART",
            "AST",
            "BET",
            "BST",
            "CAT",
            "CNT",
            "CST",
            "CTT",
            "EAT",
            "ECT",
            "IET",
            "IST",
            "JST",
            "MIT",
            "NET",
            "NST",
            "PLT",
            "PNT",
            "PRT",
            "PST",
            "SST",
            "VST",
            "Etc/Unknown",
        ];
        if ICU_ONLY
            .iter()
            .any(|alias| name.eq_ignore_ascii_case(alias))
        {
            return Err(failure("Unknown time zone"));
        }
        let index = self
            .entries
            .binary_search_by(|entry| compare(entry.name, name))
            .map_err(|_| failure("Unknown time zone"))?;
        let zone = self.find(name)?;
        let view = zone.as_ref();
        // ICU zones without a final annual rule retain the final time type,
        // including permanent daylight offsets. TZif has no fixed-DST footer.
        let final_transition = view
            .transitions()
            .last()
            .filter(|last| view.extra_rule().is_none() && epoch >= last.unix_leap_time());
        let local = if let Some(last) = final_transition {
            view.local_time_types()
                .get(last.local_time_type_index())
                .ok_or_else(|| failure("Invalid time zone data"))?
        } else {
            zone.find_local_time_type(epoch)
                .map_err(|error| failure(error.to_string()))?
        };
        let daylight = match view.extra_rule() {
            Some(tz::timezone::TransitionRule::Alternate(rule))
                if view
                    .transitions()
                    .last()
                    .is_some_and(|last| epoch >= last.unix_leap_time())
                    && rule.dst().ut_offset() < rule.std().ut_offset()
                    && (local == rule.std() || local == rule.dst()) =>
            {
                !local.is_dst()
            }
            _ => local.is_dst(),
        };
        Ok((local.ut_offset(), daylight, self.entries[index].canonical))
    }
}

fn compare(left: &str, right: &str) -> Ordering {
    left.bytes()
        .map(|byte| byte.to_ascii_lowercase())
        .cmp(right.bytes().map(|byte| byte.to_ascii_lowercase()))
}

fn take_u16(input: &mut &'static [u8]) -> ContextResult<u16> {
    let bytes = take(input, 2)?;
    <[u8; 2]>::try_from(bytes)
        .map(u16::from_le_bytes)
        .map_err(|_| failure("Truncated embedded time zone data"))
}

fn take_u32(input: &mut &'static [u8]) -> ContextResult<u32> {
    let bytes = take(input, 4)?;
    <[u8; 4]>::try_from(bytes)
        .map(u32::from_le_bytes)
        .map_err(|_| failure("Truncated embedded time zone data"))
}

fn take(input: &mut &'static [u8], length: usize) -> ContextResult<&'static [u8]> {
    let (head, tail) = input
        .split_at_checked(length)
        .ok_or_else(|| failure("Truncated embedded time zone data"))?;
    *input = tail;
    Ok(head)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_embedded_zone_parses_case_insensitively_and_paths_are_rejected() {
        let owner = TimeZoneData::new().unwrap();
        for entry in &owner.entries {
            if let Err(error) = owner.find(entry.name) {
                panic!("{}: {error}", entry.name);
            }
        }
        assert_eq!(
            owner.find("america/new_york").unwrap(),
            owner.find("America/New_York").unwrap()
        );
        assert!(owner.find("../../etc/passwd").is_err());
    }
}
