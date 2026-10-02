//! Deterministic context excerpts. Originals remain in admitted storage.

pub(super) fn text(value: &str, limit: usize, retrieval: &str) -> String {
    if value.len() <= limit {
        return value.to_owned();
    }
    let marker = format!(
        "\n[Context excerpt elided; original {} bytes; {retrieval}]\n",
        value.len()
    );
    if marker.len() > limit {
        return String::new();
    }
    let available = limit - marker.len();
    let mut head = available.div_ceil(2);
    while !value.is_char_boundary(head) {
        head -= 1;
    }
    let mut tail = value.len() - available / 2;
    while !value.is_char_boundary(tail) {
        tail += 1;
    }
    format!("{}{marker}{}", &value[..head], &value[tail..])
}

pub(super) fn priority(source: &str) -> u8 {
    match source {
        "runtime-system-contract" | "role" | "runtime-state" => 3,
        "rules" | "active-persona-reminder" | "project-memory" => 2,
        "personalization-profile" | "session-continuity" => 1,
        _ => 0,
    }
}
