//! Pure drive allocation and crash-reconciliation decisions; no subst effects.
use super::WinPath;

/// Free letters, Z through D, excluding live, persistent and journal claims.
pub fn candidates(logical: u32, persistent: &[char], claimed: &[char]) -> Vec<char> {
    ('D'..='Z')
        .rev()
        .filter(|letter| {
            logical & (1 << (*letter as u32 - 'A' as u32)) == 0
                && !persistent
                    .iter()
                    .chain(claimed)
                    .any(|used| used.eq_ignore_ascii_case(letter))
        })
        .collect()
}
/// Parses subst's `L:\: => C:\path` listing without the host Path parser.
pub fn subst_listing(text: &str) -> Result<Vec<(char, WinPath)>, &'static str> {
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let (drive, target) = line
                .trim()
                .split_once(" => ")
                .ok_or("invalid subst listing")?;
            let [letter, b':', b'\\', b':'] = drive.as_bytes() else {
                return Err("invalid subst drive");
            };
            if !letter.is_ascii_alphabetic() {
                return Err("invalid subst drive");
            }
            Ok((
                char::from(*letter).to_ascii_uppercase(),
                WinPath::new(target)?,
            ))
        })
        .collect()
}
/// Cleanup decision after checking helper PID plus start time (PID alone can be reused).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reconcile {
    /// The owning helper still runs; leave the mapping and journal alone.
    Keep,
    /// Owner dead and mapping still matches; unmap, then remove the journal.
    Unmap,
    /// Owner dead but mapping absent or replaced; only remove the journal.
    Forget,
}
/// Never unmap a letter now owned by somebody else.
pub fn reconcile(owner_alive: bool, target: &WinPath, mapped: Option<&WinPath>) -> Reconcile {
    if owner_alive {
        Reconcile::Keep
    } else if mapped == Some(target) {
        Reconcile::Unmap
    } else {
        Reconcile::Forget
    }
}
