//! Hand-built stored ZIPs retain adversarial names and Unix metadata verbatim.
use std::{fs, path::Path};

/// Build a named adversarial ZIP without normalizing its metadata.
pub fn build(path: &Path, case: &str) -> std::io::Result<()> {
    let (name, mode, body, extra, size) = specification(case)?;
    let mut output = Vec::new();
    let mut central = Vec::new();
    entry(&mut output, &mut central, name, mode, body, extra, size)?;
    if case == "link-write" {
        entry(
            &mut output,
            &mut central,
            "Butler.app/link/file",
            0o100_644,
            b"",
            b"",
            0,
        )?;
    }
    if case == "case-link" {
        entry(
            &mut output,
            &mut central,
            "Butler.app/deep/",
            0o040_755,
            b"",
            b"",
            0,
        )?;
        entry(
            &mut output,
            &mut central,
            "Butler.app/deep/B",
            0o120_777,
            b"aaa/../../escaped",
            b"",
            17,
        )?;
    }
    let count = if case == "case-link" {
        3
    } else if case == "link-write" {
        2
    } else {
        1
    };
    let offset = u32::try_from(output.len()).map_err(std::io::Error::other)?;
    let length = u32::try_from(central.len()).map_err(std::io::Error::other)?;
    output.extend(central);
    output.extend(0x0605_4b50_u32.to_le_bytes());
    for n in [0_u16, 0, count, count] {
        output.extend(n.to_le_bytes());
    }
    output.extend(length.to_le_bytes());
    output.extend(offset.to_le_bytes());
    output.extend(0_u16.to_le_bytes());
    fs::write(path, output)
}

type Specification = (&'static str, u32, &'static [u8], &'static [u8], u32);
fn specification(case: &str) -> std::io::Result<Specification> {
    Ok(match case {
        "traversal" => ("../escaped", 0o100_644, &b""[..], &b""[..], 0),
        "absolute" => ("/tmp/escaped", 0o100_644, &b""[..], &b""[..], 0),
        "symlink" => (
            "Butler.app/link",
            0o120_777,
            &b"../../escaped"[..],
            &b""[..],
            13,
        ),
        "hardlink" => (
            "Butler.app/hard",
            0o100_644,
            &b""[..],
            &b"\x0d\x00\x0d\x00\0\0\0\0\0\0\0\0\0\0\0\0x"[..],
            0,
        ),
        "oversized" => (
            "Butler.app/huge",
            0o100_644,
            &b""[..],
            &b""[..],
            1024 * 1024 * 1024 + 1,
        ),
        "fifo" => ("Butler.app/fifo", 0o010_644, &b""[..], &b""[..], 0),
        "link-write" => ("Butler.app/link", 0o120_777, &b"target"[..], &b""[..], 6),
        "case-link" => ("Butler.app/deep/AAA", 0o120_777, &b".."[..], &b""[..], 2),
        _ => return Err(std::io::Error::other("unknown fixture")),
    })
}

fn entry(
    out: &mut Vec<u8>,
    central: &mut Vec<u8>,
    name: &str,
    mode: u32,
    body: &[u8],
    extra: &[u8],
    size: u32,
) -> std::io::Result<()> {
    let offset = u32::try_from(out.len()).map_err(std::io::Error::other)?;
    let name_len = u16::try_from(name.len()).map_err(std::io::Error::other)?;
    let extra_len = u16::try_from(extra.len()).map_err(std::io::Error::other)?;
    out.extend(0x0403_4b50_u32.to_le_bytes());
    for n in [20_u16, 0, 0, 0, 0] {
        out.extend(n.to_le_bytes());
    }
    out.extend(crc32(body).to_le_bytes());
    out.extend(size.to_le_bytes());
    out.extend(size.to_le_bytes());
    out.extend(name_len.to_le_bytes());
    out.extend(extra_len.to_le_bytes());
    out.extend(name.as_bytes());
    out.extend(extra);
    out.extend(body);
    central.extend(0x0201_4b50_u32.to_le_bytes());
    for n in [0x0314_u16, 20, 0, 0, 0, 0] {
        central.extend(n.to_le_bytes());
    }
    central.extend(crc32(body).to_le_bytes());
    central.extend(size.to_le_bytes());
    central.extend(size.to_le_bytes());
    for n in [name_len, extra_len, 0, 0, 0] {
        central.extend(n.to_le_bytes());
    }
    central.extend((mode << 16).to_le_bytes());
    central.extend(offset.to_le_bytes());
    central.extend(name.as_bytes());
    central.extend(extra);
    Ok(())
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0_u32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320_u32 & 0_u32.wrapping_sub(crc & 1));
        }
    }
    !crc
}
