use std::path::Path;

// Compare the pattern to each component of the credential root. Once the root
// is consumed, any remaining pattern can name a descendant. Never enumerate.
pub(super) fn overlaps(pattern: &Path, root: &Path, posix: bool) -> bool {
    compare(pattern, root, false, posix)
}
pub(super) fn overlaps_ancestor(pattern: &Path, root: &Path, posix: bool) -> bool {
    compare(pattern, root, true, posix)
}
fn compare(pattern: &Path, root: &Path, ancestors: bool, posix: bool) -> bool {
    let insensitive = super::comparison::insensitive(root);
    let pattern: Vec<_> = pattern
        .components()
        .map(|p| p.as_os_str().to_string_lossy().into_owned())
        .collect();
    let root: Vec<_> = root
        .components()
        .map(|p| p.as_os_str().to_string_lossy().into_owned())
        .collect();
    let mut prefix = std::path::PathBuf::new();
    for (index, component) in root.into_iter().enumerate() {
        let Some(part) = pattern.get(index) else {
            return ancestors && prefix.try_exists().unwrap_or(true);
        };
        if part == "**" && (!posix || !component.starts_with('.')) {
            return true;
        }
        if !matches(part, &component, insensitive, posix) {
            return false;
        }
        prefix.push(component);
    }
    true
}
fn matches(pattern: &str, text: &str, insensitive: bool, posix: bool) -> bool {
    if posix && text.starts_with('.') && !pattern.starts_with('.') {
        return false;
    }
    let folded = insensitive.then(|| (pattern.to_lowercase(), text.to_lowercase()));
    let (pattern, text) = folded
        .as_ref()
        .map_or((pattern, text), |(p, t)| (p.as_str(), t.as_str()));
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
                *diagonal && (atom == '?' || atom == ch)
            };
            next.push(left);
        }
        reachable = next;
    }
    reachable.last().copied().unwrap_or(false)
}
