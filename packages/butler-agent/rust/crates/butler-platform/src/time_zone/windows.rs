//! Windows has no zoneinfo directory: the rules are the baseline archive that the
//! executable embeds (`BTZ2`: a count, then per zone its name, canonical
//! name and TZif bytes, sorted by lower-case name).

use std::cmp::Ordering;
use std::io;

pub(super) fn zone_rules(name: &str) -> io::Result<Vec<u8>> {
    lookup(super::BASELINE_ARCHIVE, name).ok_or_else(|| io::ErrorKind::NotFound.into())
}

fn lookup(data: &[u8], name: &str) -> Option<Vec<u8>> {
    let mut input = data.strip_prefix(b"BTZ2")?;
    let count = take_u32(&mut input)?;
    let mut entries = Vec::new();
    for _ in 0..count {
        let name_len = usize::from(take_u16(&mut input)?);
        let canonical_len = usize::from(take_u16(&mut input)?);
        let data_len = usize::try_from(take_u32(&mut input)?).ok()?;
        let entry_name = take(&mut input, name_len)?;
        take(&mut input, canonical_len)?;
        entries.push((entry_name, take(&mut input, data_len)?));
    }
    let index = entries
        .binary_search_by(|(entry, _)| compare(entry, name.as_bytes()))
        .ok()?;
    entries.get(index).map(|(_, bytes)| bytes.to_vec())
}

fn compare(left: &[u8], right: &[u8]) -> Ordering {
    left.iter()
        .map(u8::to_ascii_lowercase)
        .cmp(right.iter().map(u8::to_ascii_lowercase))
}

fn take_u16(input: &mut &[u8]) -> Option<u16> {
    let bytes = <[u8; 2]>::try_from(take(input, 2)?).ok()?;
    Some(u16::from_le_bytes(bytes))
}

fn take_u32(input: &mut &[u8]) -> Option<u32> {
    let bytes = <[u8; 4]>::try_from(take(input, 4)?).ok()?;
    Some(u32::from_le_bytes(bytes))
}

fn take<'a>(input: &mut &'a [u8], length: usize) -> Option<&'a [u8]> {
    let (head, tail) = input.split_at_checked(length)?;
    *input = tail;
    Some(head)
}
