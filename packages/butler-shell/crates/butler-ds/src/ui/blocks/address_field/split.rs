//! `splitAddress` (splitAddress.ts): the host and the rest of a URL, as the address field shows
//! them (no scheme, no trailing slash).

/// The host and the path (with query and fragment) of `url`; an input that is not an absolute URL
/// with a host is all host.
pub fn split_address(url: &str) -> (String, String) {
    let value = url.trim();
    if value.is_empty() {
        return (String::new(), String::new());
    }
    match parse(value) {
        Some((host, rest)) => {
            let rest = if rest.is_empty() || rest == "/" {
                String::new()
            } else {
                rest.to_owned()
            };
            (host, decode_uri(&rest))
        }
        None => (value.to_owned(), String::new()),
    }
}

/// The scheme, `//`, host and the remainder of an absolute URL with an authority.
fn parse(value: &str) -> Option<(String, &str)> {
    let colon = value.find(':')?;
    let scheme = &value[..colon];
    let mut chars = scheme.chars();
    let valid = chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    let authority = value[colon + 1..].strip_prefix("//").filter(|_| valid)?;
    let end = authority.find(['/', '?', '#']).unwrap_or(authority.len());
    let (authority, rest) = authority.split_at(end);
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = without_default_port(&host.to_ascii_lowercase(), &scheme.to_ascii_lowercase());
    (!host.is_empty()).then_some((host, rest))
}

/// `URL.host`: the port is dropped when it is the scheme's default.
fn without_default_port(host: &str, scheme: &str) -> String {
    let default = match scheme {
        "http" | "ws" => "80",
        "https" | "wss" => "443",
        "ftp" => "21",
        _ => "",
    };
    match host.rsplit_once(':') {
        Some((name, port)) if !default.is_empty() && port == default && !host.ends_with(']') => {
            name.to_owned()
        }
        _ => host.to_owned(),
    }
}

/// `decodeURI`: decodes `%XX` sequences that are valid UTF-8, except those that stand for a
/// reserved character; the text stays encoded when it is not valid UTF-8.
fn decode_uri(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |at: usize| {
            let pair = bytes.get(at + 1..at + 3)?;
            u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()
        };
        match (bytes[i], hex(i)) {
            (b'%', Some(byte)) if !b";/?:@&=+$,#".contains(&byte) => {
                out.push(byte);
                i += 3;
            }
            (b'%', Some(_)) => {
                out.extend_from_slice(&bytes[i..i + 3]);
                i += 3;
            }
            (b'%', None) => return text.to_owned(),
            (byte, _) => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| text.to_owned())
}
