//! PowerShell source text built from values, with no host side effects.

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
