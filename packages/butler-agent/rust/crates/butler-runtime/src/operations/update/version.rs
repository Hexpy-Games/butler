//! Version ordering shared by update checks and the installed-version list.

/// Whether `available` is a newer version than `current`, comparing the
/// numeric segments of `1.2.3-4` style versions left to right.
pub fn version_newer(available: &str, current: &str) -> bool {
    let parse = |version: &str| {
        version
            .split(['.', '-'])
            .map(|part| {
                part.chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>()
                    .parse::<u64>()
                    .unwrap_or(0)
            })
            .collect::<Vec<_>>()
    };
    let available = parse(available);
    let current = parse(current);
    (0..available.len().max(current.len()).max(3))
        .map(|index| {
            (
                available.get(index).copied().unwrap_or(0),
                current.get(index).copied().unwrap_or(0),
            )
        })
        .find(|(left, right)| left != right)
        .is_some_and(|(left, right)| left > right)
}

#[cfg(test)]
mod tests {
    use super::version_newer;

    // test-category: pure-logic
    #[test]
    fn compares_source_version_segments() {
        assert!(version_newer("1.2.1", "1.2.0"));
        assert!(!version_newer("1.2.0", "1.2.0"));
        assert!(!version_newer("1.1.9", "1.2.0"));
    }
}
