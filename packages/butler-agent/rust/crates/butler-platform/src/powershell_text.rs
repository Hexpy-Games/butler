//! PowerShell source text built from values, with no host side effects.

use base64::{Engine, engine::general_purpose::STANDARD};

/// `word` as a single-quoted PowerShell string. PowerShell reads the typographic single
/// quotes as delimiters too, so each of them is doubled like the plain one.
pub fn literal(word: &str) -> String {
    let mut literal = String::with_capacity(word.len() + 2);
    literal.push('\'');
    for character in word.chars() {
        if matches!(
            character,
            '\'' | '\u{2018}' | '\u{2019}' | '\u{201a}' | '\u{201b}'
        ) {
            literal.push(character);
        }
        literal.push(character);
    }
    literal.push('\'');
    literal
}

/// `value` as a PowerShell expression decoding it from base64 UTF-8 at run time,
/// so the script stays ASCII and PowerShell never parses the value itself.
pub fn decoded(value: &str) -> String {
    format!(
        "([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{}')))",
        STANDARD.encode(value)
    )
}

/// A `powershell` command line running `script`, passed as UTF-16LE base64 so
/// no default shell (cmd, PowerShell or pwsh) re-parses it.
pub fn encoded_command(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    format!(
        "powershell -NoProfile -NonInteractive -EncodedCommand {}",
        STANDARD.encode(bytes)
    )
}
