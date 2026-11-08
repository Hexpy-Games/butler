//! `logs-export.mjs` `appendZipEntry`: one stored (uncompressed) entry added to a finished zip.
//! The new local header and data replace the old central directory, which is written again
//! after them with the new entry and a new end record. zip64 and damaged archives are refused.

const EOCD_SIGNATURE: u32 = 0x0605_4b50;
const EOCD_BYTES: usize = 22;
const MAX_COMMENT: usize = 0xffff;

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = !0_u32;
    for &byte in data {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xEDB8_8320 & 0_u32.wrapping_sub(crc & 1));
        }
    }
    !crc
}

/// A local (`offset` none) or central directory header for a stored UTF-8 entry.
fn header(name: &[u8], length: u32, checksum: u32, offset: Option<u32>) -> Option<Vec<u8>> {
    let mut bytes = Vec::with_capacity(46 + name.len());
    let signature: u32 = if offset.is_some() {
        0x0201_4b50
    } else {
        0x0403_4b50
    };
    bytes.extend(signature.to_le_bytes());
    if offset.is_some() {
        bytes.extend(20_u16.to_le_bytes()); // version made by
    }
    bytes.extend(20_u16.to_le_bytes()); // version needed
    bytes.extend(0x0800_u16.to_le_bytes()); // UTF-8 name
    bytes.extend(0_u16.to_le_bytes()); // stored
    bytes.extend(0_u16.to_le_bytes()); // time
    bytes.extend(0x21_u16.to_le_bytes()); // date: 1980-01-01
    bytes.extend(checksum.to_le_bytes());
    bytes.extend(length.to_le_bytes());
    bytes.extend(length.to_le_bytes());
    bytes.extend(u16::try_from(name.len()).ok()?.to_le_bytes());
    if let Some(offset) = offset {
        // extra, comment, disk, internal and external attributes, then the local header offset.
        bytes.extend([0_u8; 12]);
        bytes.extend(offset.to_le_bytes());
    } else {
        bytes.extend(0_u16.to_le_bytes()); // extra length
    }
    bytes.extend(name);
    Some(bytes)
}

/// Appends `name` with `data` to the zip in `zip`; false (and `zip` unchanged) when it cannot.
pub(crate) fn append_entry(zip: &mut Vec<u8>, name: &str, data: &[u8]) -> bool {
    append(zip, name, data).is_some()
}

fn append(zip: &mut Vec<u8>, name: &str, data: &[u8]) -> Option<()> {
    let size = zip.len();
    let tail_start = size.saturating_sub(EOCD_BYTES + MAX_COMMENT);
    let tail = zip.get(tail_start..)?;
    let end = tail
        .windows(4)
        .rposition(|window| window == [0x50, 0x4b, 0x05, 0x06])?;
    if u32_at(tail, end)? != EOCD_SIGNATURE {
        return None;
    }
    let entries = u16_at(tail, end + 10)?;
    let directory_bytes = usize::try_from(u32_at(tail, end + 12)?).ok()?;
    let directory_offset = u32_at(tail, end + 16)?;
    let offset = usize::try_from(directory_offset).ok()?;
    if entries == 0xffff
        || directory_offset == 0xffff_ffff
        || offset.checked_add(directory_bytes)? > size
    {
        return None;
    }
    let name = name.as_bytes();
    let length = u32::try_from(data.len()).ok()?;
    let checksum = crc32(data);
    let local = header(name, length, checksum, None)?;
    let central = header(name, length, checksum, Some(directory_offset))?;
    let new_offset = u32::try_from(offset + local.len() + data.len()).ok()?;
    let directory = zip.get(offset..offset + directory_bytes)?.to_vec();
    let mut record = Vec::with_capacity(EOCD_BYTES);
    record.extend(EOCD_SIGNATURE.to_le_bytes());
    record.extend([0_u8; 4]); // disk numbers
    record.extend((entries + 1).to_le_bytes());
    record.extend((entries + 1).to_le_bytes());
    record.extend(
        u32::try_from(directory_bytes + central.len())
            .ok()?
            .to_le_bytes(),
    );
    record.extend(new_offset.to_le_bytes());
    record.extend(0_u16.to_le_bytes()); // comment length
    zip.truncate(offset);
    for part in [&local, data, &directory, &central, &record] {
        zip.extend_from_slice(part);
    }
    Some(())
}
