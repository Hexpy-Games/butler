//! Windows command lines built from values, with no host side effects.

/// One argument quoted for the MSVC command-line parser.
pub fn quote_argument(value: &str) -> String {
    let mut output = String::from("\"");
    let mut slashes = 0;
    for ch in value.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        output.push_str(&"\\".repeat(if ch == '"' { slashes * 2 + 1 } else { slashes }));
        slashes = 0;
        output.push(ch);
    }
    output.push_str(&"\\".repeat(slashes * 2));
    output.push('"');
    output
}
