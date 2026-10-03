pub(super) fn has_background(command: &str, escape: char) -> bool {
    let mut quote = None;
    let mut escaped = false;
    let mut previous = None;
    let mut chars = command.chars().peekable();
    while let Some(ch) = chars.next() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == escape && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if let Some(delimiter) = quote {
            if ch == delimiter {
                quote = None;
            }
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
        } else if ch == '&' && previous != Some('&') && !matches!(chars.peek(), Some('&' | '>')) {
            return true;
        }
        previous = Some(ch);
    }
    false
}
