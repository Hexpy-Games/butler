//! What the markdown pipeline does to a run of plain text after parsing: the punctuation-bold
//! suffix fix (`remarkPunctuationBoldSuffix.ts`) and the GFM literal autolinks (`remark-gfm`:
//! `https://`, `http://` and `www.` addresses, and e-mail addresses).
use super::model::{Inline, Style};

/// Whether `c` is in Unicode general category P (punctuation), for the characters text in a
/// chat reply uses: ASCII punctuation (not the symbols `$ + < = > ^ ` | ~`) and the General
/// Punctuation, CJK and fullwidth blocks.
pub(super) fn is_punctuation(c: char) -> bool {
    if c.is_ascii() {
        return matches!(
            c,
            '!' | '"'
                | '#'
                | '%'
                | '&'
                | '\''
                | '('
                | ')'
                | '*'
                | ','
                | '-'
                | '.'
                | '/'
                | ':'
                | ';'
                | '?'
                | '@'
                | '['
                | '\\'
                | ']'
                | '_'
                | '{'
                | '}'
        );
    }
    matches!(c as u32,
        0xA1 | 0xA7 | 0xAB | 0xB6 | 0xB7 | 0xBB | 0xBF
        | 0x2010..=0x2027 | 0x2030..=0x205E
        | 0x3001..=0x3003 | 0x3008..=0x3011 | 0x3014..=0x301F | 0x30FB
        | 0xFF01..=0xFF03 | 0xFF05..=0xFF0A | 0xFF0C..=0xFF0F | 0xFF1A | 0xFF1B | 0xFF1F
        | 0xFF20 | 0xFF3B..=0xFF3D | 0xFF3F | 0xFF5B | 0xFF5D | 0xFF5F..=0xFF65)
}

/// One piece of a text run: plain, or bold from the suffix fix.
struct Piece {
    start: usize,
    end: usize,
    bold: bool,
}

/// `**text.**word`: CommonMark leaves the closing `**` after punctuation and before a word
/// character as literal text; the pipeline turns it into bold, as
/// `/\*\*([^\n*]+?\p{P})\*\*(?=[\p{L}\p{N}])/gu` does. Empty when nothing matches.
fn punctuation_bold(text: &str) -> Vec<Piece> {
    let mut pieces = Vec::new();
    let mut cursor = 0;
    let mut from = 0;
    while let Some(found) = text[from..].find("**") {
        let open = from + found;
        let body = open + 2;
        let Some(close) = text[body..].find("**").map(|at| body + at) else {
            break;
        };
        let inner = &text[body..close];
        let next = text[close + 2..].chars().next();
        let fits = !inner.contains(['\n', '*'])
            && inner.chars().last().is_some_and(is_punctuation)
            && inner.chars().count() >= 2
            && next.is_some_and(char::is_alphanumeric);
        if fits {
            if open > cursor {
                pieces.push(Piece {
                    start: cursor,
                    end: open,
                    bold: false,
                });
            }
            pieces.push(Piece {
                start: body,
                end: close,
                bold: true,
            });
            cursor = close + 2;
            from = cursor;
        } else {
            from = open + 1;
        }
    }
    if pieces.is_empty() {
        return pieces;
    }
    if cursor < text.len() {
        pieces.push(Piece {
            start: cursor,
            end: text.len(),
            bold: false,
        });
    }
    pieces
}

/// Characters of a domain that `remark-gfm` accepts.
fn is_domain(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '-' | '.' | '_')
}

/// Trims what cannot end an autolink: trailing punctuation and an unbalanced `)`.
fn trim_url(url: &str) -> &str {
    let mut end = url.len();
    while let Some(last) = url[..end].chars().last() {
        let cut = &url[..end];
        let trim = match last {
            '!' | '"' | '&' | '\'' | ',' | '.' | ':' | ';' | '<' | '>' | '?' | ']' | '}' | '*'
            | '_' | '~' => true,
            ')' => cut.matches(')').count() > cut.matches('(').count(),
            _ => false,
        };
        if !trim {
            break;
        }
        end -= last.len_utf8();
    }
    &url[..end]
}

/// Whether an autolink may start after `before`: the start of the text, whitespace or one of
/// `* _ ~ ( " '`.
fn boundary(before: Option<char>) -> bool {
    before.is_none_or(|c| c.is_whitespace() || matches!(c, '*' | '_' | '~' | '(' | '"' | '\''))
}

/// `(start, end, href)` of every autolink in `text`.
fn autolinks(text: &str) -> Vec<(usize, usize, String)> {
    let mut found: Vec<(usize, usize, String)> = Vec::new();
    let lower = text.to_ascii_lowercase();
    let mut at = 0;
    while at < text.len() {
        let prefix = ["https://", "http://", "www."]
            .into_iter()
            .find(|prefix| lower[at..].starts_with(prefix));
        if let Some(prefix) = prefix.filter(|_| boundary(text[..at].chars().last())) {
            let tail = &text[at..];
            let stop = tail.find(char::is_whitespace).unwrap_or(tail.len());
            let url = trim_url(&tail[..stop]);
            let host = &url[prefix.len().min(url.len())..];
            let host_len = host.find(|c: char| !is_domain(c)).unwrap_or(host.len());
            if host_len > 0 {
                let href = if prefix == "www." {
                    format!("http://{url}")
                } else {
                    url.to_owned()
                };
                found.push((at, at + url.len(), href));
                at += url.len();
                continue;
            }
        }
        at += text[at..].chars().next().map_or(1, char::len_utf8);
    }
    emails(text, &mut found);
    found.sort_by_key(|link| link.0);
    found
}

/// `name@host.tld` addresses that no web link already covers.
fn emails(text: &str, found: &mut Vec<(usize, usize, String)>) {
    let local = |c: char| c.is_alphanumeric() || matches!(c, '-' | '.' | '_' | '+');
    for (at, _) in text.match_indices('@') {
        let start = text[..at]
            .char_indices()
            .rev()
            .take_while(|(_, c)| local(*c))
            .last()
            .map_or(at, |(i, _)| i);
        let domain = &text[at + 1..];
        let len = domain.find(|c: char| !is_domain(c)).unwrap_or(domain.len());
        let host = domain[..len].trim_end_matches(['.', '-', '_']);
        if start == at || !host.contains('.') || host.starts_with('.') {
            continue;
        }
        let end = at + 1 + host.len();
        if found.iter().any(|(s, e, _)| start < *e && *s < end) {
            continue;
        }
        found.push((start, end, format!("mailto:{}", &text[start..end])));
    }
}

/// A text run as inline nodes: bold from the suffix fix, links from the literal autolinks.
/// `origin` is where the run starts in the source when it is the source verbatim (escapes and
/// entities make the two differ, and the suffix fix then does not apply), and `in_link` says
/// the run sits inside a link, where autolinks do not apply.
pub(super) fn run(text: &str, style: Style, origin: Option<usize>, in_link: bool) -> Vec<Inline> {
    let pieces = if origin.is_some() {
        punctuation_bold(text)
    } else {
        Vec::new()
    };
    if pieces.is_empty() {
        return links(text, style, origin, in_link);
    }
    let mut nodes = Vec::new();
    for piece in pieces {
        let part = &text[piece.start..piece.end];
        let at = origin.map(|base| base + piece.start);
        if piece.bold {
            nodes.push(Inline::Text {
                text: part.to_owned(),
                style: Style {
                    bold: true,
                    ..style
                },
                source: at,
            });
        } else {
            nodes.extend(links(part, style, at, in_link));
        }
    }
    nodes
}

fn links(text: &str, style: Style, origin: Option<usize>, in_link: bool) -> Vec<Inline> {
    let found = if in_link { Vec::new() } else { autolinks(text) };
    let plain = |part: &str, offset: usize| Inline::Text {
        text: part.to_owned(),
        style,
        source: origin.map(|base| base + offset),
    };
    let mut nodes = Vec::new();
    let mut cursor = 0;
    for (start, end, href) in found {
        if start > cursor {
            nodes.push(plain(&text[cursor..start], cursor));
        }
        nodes.push(Inline::Link {
            href,
            children: vec![plain(&text[start..end], start)],
        });
        cursor = end;
    }
    if cursor < text.len() || nodes.is_empty() {
        nodes.push(plain(&text[cursor..], cursor));
    }
    nodes
}
