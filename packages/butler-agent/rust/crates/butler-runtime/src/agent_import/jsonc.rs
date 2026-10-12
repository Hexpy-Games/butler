//! OpenCode JSON with comments and trailing commas.
use super::FormatError;
use serde_json::Value;

/// The `mcp` table of an OpenCode configuration.
pub(super) fn mcp_servers(text: &str) -> Result<Value, FormatError> {
    let mut config: Value = serde_json::from_str(&plain(text)).map_err(|_| FormatError)?;
    Ok(config["mcp"].take())
}

/// Drops comments and trailing commas outside strings; everything else is kept.
fn plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            match c {
                '\\' => out.extend(chars.next()),
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match (c, chars.peek()) {
            ('"', _) => {
                in_string = true;
                out.push(c);
            }
            ('/', Some('/')) => {
                for next in chars.by_ref() {
                    if next == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            ('/', Some('*')) => {
                chars.next();
                let mut last = ' ';
                for next in chars.by_ref() {
                    if last == '*' && next == '/' {
                        break;
                    }
                    last = next;
                }
                out.push(' ');
            }
            ('}' | ']', _) => {
                if out.trim_end().ends_with(',') {
                    let kept = out.trim_end().len().saturating_sub(1);
                    out.truncate(kept);
                }
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}
