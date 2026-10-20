use std::path::Path;

// Compare the pattern to each component of the credential root. Once the root
// is consumed, any remaining pattern can name a descendant. Never enumerate.
pub(super) fn overlaps(pattern: &Path, root: &Path) -> bool {
    let pattern: Vec<_> = pattern
        .components()
        .map(|p| p.as_os_str().to_string_lossy().into_owned())
        .collect();
    let root: Vec<_> = root
        .components()
        .map(|p| p.as_os_str().to_string_lossy().into_owned())
        .collect();
    for (index, component) in root.into_iter().enumerate() {
        let Some(part) = pattern.get(index) else {
            return false;
        };
        if part == "**" {
            return true;
        }
        if !matches(part, &component) {
            return false;
        }
    }
    true
}
fn matches(pattern: &str, text: &str) -> bool {
    let mut reachable: Vec<_> = std::iter::once(true)
        .chain(std::iter::repeat_n(false, text.chars().count()))
        .collect();
    for atom in pattern.chars() {
        if atom == '[' {
            return true; // Character classes are conservatively unknown.
        }
        let mut left = atom == '*' && reachable.first().copied().unwrap_or(false);
        let mut next = vec![left];
        let states = reachable.iter().zip(reachable.iter().skip(1));
        for (ch, (diagonal, above)) in text.chars().zip(states) {
            left = if atom == '*' {
                *above || left
            } else {
                *diagonal && (atom == '?' || equal(atom, ch))
            };
            next.push(left);
        }
        reachable = next;
    }
    reachable.last().copied().unwrap_or(false)
}

fn equal(left: char, right: char) -> bool {
    #[cfg(windows)]
    {
        left.eq_ignore_ascii_case(&right)
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}
