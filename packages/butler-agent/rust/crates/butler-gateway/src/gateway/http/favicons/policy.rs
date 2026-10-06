//! Host, resolved address and raster admission. Every network hop uses these guards.
use std::net::IpAddr;

pub(super) fn valid_host(host: &str) -> bool {
    host.len() <= 253
        && host.contains('.')
        && host.parse::<IpAddr>().is_err()
        && !host.bytes().all(|c| c.is_ascii_digit() || c == b'.')
        && !["local", "internal", "localhost", "test"]
            .iter()
            .any(|suffix| host.ends_with(&format!(".{suffix}")))
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        })
}

pub(super) fn public_ip(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(ip) => {
            let [a, b, ..] = ip.octets();
            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_multicast()
                && !ip.is_unspecified()
                && !ip.is_broadcast()
                && a != 0
                && !(a == 100 && (64..=127).contains(&b))
                && !(a == 192 && b == 0)
                && a < 240
                && !ip.is_documentation()
                && !(a == 198 && (b == 18 || b == 19))
        }
        IpAddr::V6(ip) => {
            let first = ip.segments()[0];
            !ip.is_loopback()
                && !ip.is_unspecified()
                && !ip.is_multicast()
                && first & 0xfe00 != 0xfc00
                && first & 0xffc0 != 0xfe80
                && first & 0xffc0 != 0xfec0
                && first & 0xe000 == 0x2000
                && !(first == 0x2001 && ip.segments()[1] == 0xdb8)
        }
    }
}

pub(super) fn raster(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(("image/png", "png"))
    } else if bytes.starts_with(b"\0\0\x01\0") {
        Some(("image/x-icon", "ico"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(("image/gif", "gif"))
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some(("image/jpeg", "jpg"))
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some(("image/webp", "webp"))
    } else {
        None
    }
}
