//! Windows CRT quoting plus the existing cmd /s raw envelope.
use crate::command_sandbox::Invocation;

/// Encodes the complete invocation without reinterpreting cmd command text.
pub fn command_line(invocation: &Invocation) -> Result<String, &'static str> {
    if invocation.program.is_empty()
        || invocation.program.contains(['\0', '"'])
        || invocation.arguments.iter().any(|arg| arg.contains('\0'))
    {
        return Err("invalid command line");
    }
    let program = invocation
        .program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default();
    let cmd = program.eq_ignore_ascii_case("cmd.exe") || program.eq_ignore_ascii_case("cmd");
    let mut line = quote(&invocation.program, true);
    if cmd
        && let [d, s, c, text] = invocation.arguments.as_slice()
        && [d.as_str(), s.as_str(), c.as_str()] == ["/d", "/s", "/c"]
    {
        line.push_str(&format!(" /d /s /c \"{text}\""));
    } else {
        for arg in &invocation.arguments {
            line.push(' ');
            line.push_str(&quote(arg, false));
        }
    }
    if line.encode_utf16().count() >= 32_767 {
        return Err("command line too long");
    }
    Ok(line)
}
fn quote(value: &str, force: bool) -> String {
    if !force && !value.is_empty() && !value.contains([' ', '\t', '"']) {
        return value.into();
    }
    let mut result = String::from("\"");
    let mut slashes = 0;
    for ch in value.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        result.extend(std::iter::repeat_n(
            '\\',
            if ch == '"' { slashes * 2 + 1 } else { slashes },
        ));
        result.push(ch);
        slashes = 0;
    }
    result.extend(std::iter::repeat_n('\\', slashes * 2));
    result.push('"');
    result
}
