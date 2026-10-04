//! Lexical candidates, retaining enough shell context to distinguish syntax.
use super::shell;

/// Extract path candidates for screening, not shell interpretation. In
/// particular, a PowerShell member-access dot is not the current directory.
pub fn path_tokens(command: &str) -> Vec<&str> {
    let command = shell::path_script(command);
    let mut tokens = Vec::new();
    let mut start = 0;
    let mut quote = None;
    let mut escaped = false;
    let mut member = false;
    let mut previous = None;
    for (offset, ch) in command.char_indices() {
        if offset == start {
            member = shell::member_access_dot(ch, previous, quote.is_some());
        }
        let delimiter =
            ch.is_whitespace() || ['"', '\'', ';', '|', '(', ')', ',', '='].contains(&ch);
        if delimiter {
            if offset > start && !(member && &command[start..offset] == ".") {
                tokens.push(&command[start..offset]);
            }
            start = offset + ch.len_utf8();
        }
        if !escaped && ['"', '\''].contains(&ch) {
            if quote == Some(ch) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(ch);
            }
        }
        escaped = !escaped && ch == shell::ESCAPE;
        previous = Some(ch);
    }
    if start < command.len() {
        tokens.push(&command[start..]);
    }
    tokens
}
