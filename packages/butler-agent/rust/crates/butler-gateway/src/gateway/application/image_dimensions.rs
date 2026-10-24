//! Read raster dimensions from container headers only; never decode pixel data.
pub(super) fn read(bytes: &[u8]) -> Option<(u32, u32)> {
    let dimensions = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        if bytes.get(8..16)? != b"\0\0\0\rIHDR" {
            return None;
        }
        (
            u32::from_be_bytes(bytes.get(16..20)?.try_into().ok()?),
            u32::from_be_bytes(bytes.get(20..24)?.try_into().ok()?),
        )
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        (
            u32::from(u16::from_le_bytes(bytes.get(6..8)?.try_into().ok()?)),
            u32::from(u16::from_le_bytes(bytes.get(8..10)?.try_into().ok()?)),
        )
    } else if bytes.starts_with(b"\xff\xd8") {
        jpeg(bytes)?
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12)? == b"WEBP" {
        webp(bytes)?
    } else {
        return None;
    };
    (dimensions.0 > 0 && dimensions.1 > 0).then_some(dimensions)
}

fn jpeg(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut offset = 2;
    loop {
        if *bytes.get(offset)? != 0xff {
            return None;
        }
        while *bytes.get(offset)? == 0xff {
            offset += 1;
        }
        let marker = *bytes.get(offset)?;
        offset += 1;
        match marker {
            0xd9 | 0xda | 0x00 => return None,
            0x01 | 0xd0..=0xd8 => continue,
            _ => {}
        }
        let length = usize::from(u16::from_be_bytes(
            bytes.get(offset..offset + 2)?.try_into().ok()?,
        ));
        let segment = bytes.get(offset..offset.checked_add(length)?)?;
        if length < 2 {
            return None;
        }
        if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
            return Some((
                u32::from(u16::from_be_bytes(segment.get(5..7)?.try_into().ok()?)),
                u32::from(u16::from_be_bytes(segment.get(3..5)?.try_into().ok()?)),
            ));
        }
        offset += length;
    }
}

fn webp(bytes: &[u8]) -> Option<(u32, u32)> {
    let end = usize::try_from(u32::from_le_bytes(bytes.get(4..8)?.try_into().ok()?))
        .ok()?
        .checked_add(8)?;
    let bytes = bytes.get(..end)?;
    let mut offset: usize = 12;
    while offset < bytes.len() {
        let tag = bytes.get(offset..offset + 4)?;
        let size = usize::try_from(u32::from_le_bytes(
            bytes.get(offset + 4..offset + 8)?.try_into().ok()?,
        ))
        .ok()?;
        offset = offset.checked_add(8)?;
        let chunk = bytes.get(offset..offset.checked_add(size)?)?;
        match tag {
            b"VP8X" => return Some((1 + le24(chunk.get(4..7)?)?, 1 + le24(chunk.get(7..10)?)?)),
            b"VP8L" if chunk.first() == Some(&0x2f) => {
                let bits = u32::from_le_bytes(chunk.get(1..5)?.try_into().ok()?);
                return Some((1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)));
            }
            b"VP8 " if chunk.get(3..6)? == b"\x9d\x01\x2a" => {
                return Some((
                    u32::from(u16::from_le_bytes(chunk.get(6..8)?.try_into().ok()?) & 0x3fff),
                    u32::from(u16::from_le_bytes(chunk.get(8..10)?.try_into().ok()?) & 0x3fff),
                ));
            }
            _ => {}
        }
        offset = offset.checked_add(size)?.checked_add(size % 2)?;
    }
    None
}

fn le24(bytes: &[u8]) -> Option<u32> {
    Some(u32::from_le_bytes([
        *bytes.first()?,
        *bytes.get(1)?,
        *bytes.get(2)?,
        0,
    ]))
}
