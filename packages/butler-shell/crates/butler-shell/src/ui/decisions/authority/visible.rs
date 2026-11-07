//! `app/visibleText.ts`: approval text is the exact action, so characters that hide or reflow it
//! show as escapes. A newline reads `⏎`; every other hidden character reads `‹U+XXXX›`.

use std::fmt::Write as _;

/// Control and format characters, default-ignorable ones (fillers, variation selectors),
/// private-use ones, non-ASCII whitespace, the blank Braille pattern, the object replacement
/// character, combining overlay marks, and the escape's own glyphs.
fn hidden(c: char) -> bool {
    let code = c as u32;
    c.is_control()
        || c.is_whitespace()
        || matches!(
            code,
            0x00AD | 0x034F | 0x061C | 0x115F | 0x1160 | 0x17B4 | 0x17B5 | 0x180B..=0x180F
                | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x206F | 0x2800 | 0x3164
                | 0xFE00..=0xFE0F | 0xFEFF | 0xFFA0 | 0xFFF0..=0xFFF8 | 0xFFFC | 0xE0000..=0xE0FFF
                | 0xE000..=0xF8FF | 0xF0000..=0xFFFFD | 0x0010_0000..=0x0010_FFFD
                | 0x0334..=0x0338 | 0x20D2 | 0x20D3 | 0x20D8..=0x20DA | 0x20DD..=0x20E4
                | 0x23CE | 0x2039 | 0x203A
        )
}

fn escape(text: &str, kept: impl Fn(char) -> Option<char>) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if !hidden(c) {
            out.push(c);
        } else if let Some(kept) = kept(c) {
            out.push(kept);
        } else {
            let _ = write!(out, "‹U+{:04X}›", c as u32);
        }
    }
    out
}

pub(super) fn visible_text(text: &str) -> String {
    escape(text, |c| match c {
        ' ' => Some(' '),
        '\n' => Some('⏎'),
        _ => None,
    })
}

/// A command body in a code frame: the space, the tab and the newline stay real.
pub(super) fn visible_code(text: &str) -> String {
    escape(text, |c| matches!(c, ' ' | '\t' | '\n').then_some(c))
}

/// `approvalText` for a text line: a run of five or more spaces shows as a count, and a space
/// next to a space or at an end becomes a no-break space so it keeps its width.
pub(super) fn approval_line(text: &str) -> String {
    let escaped = visible_text(text);
    let mut runs = String::with_capacity(escaped.len());
    let mut chars = escaped.chars().peekable();
    while let Some(c) = chars.next() {
        if c != ' ' {
            runs.push(c);
            continue;
        }
        let mut length = 1;
        while chars.next_if_eq(&' ').is_some() {
            length += 1;
        }
        if length >= 5 {
            let _ = write!(runs, "‹U+0020×{length}›");
        } else {
            runs.extend(std::iter::repeat_n(' ', length));
        }
    }
    let chars: Vec<char> = runs.chars().collect();
    chars
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let edge = i == 0 || i + 1 == chars.len();
            let next_space = chars.get(i + 1) == Some(&' ');
            if *c == ' ' && (edge || next_space) {
                '\u{A0}'
            } else {
                *c
            }
        })
        .collect()
}
