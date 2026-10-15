//! Drive-absolute, case-insensitive paths, independent of the host's Path parser.
use serde::Serialize;

/// A normalized local Windows path. Device/UNC paths and ambiguous names fail closed.
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash, Serialize)]
#[serde(transparent)]
pub struct WinPath(String);
impl WinPath {
    /// Parses an absolute drive path; rejects aliases, ADS and relative components.
    pub fn new(value: &str) -> Result<Self, &'static str> {
        let value = value.replace('/', "\\");
        if value.starts_with("\\\\?\\") || value.starts_with("\\\\.\\") {
            return Err("device or extended-length path prefix");
        }
        if value.starts_with("\\\\") {
            return Err("UNC path prefix");
        }
        let [letter, b':', b'\\', ..] = value.as_bytes() else {
            return Err("local drive-absolute path required");
        };
        if !letter.is_ascii_alphabetic() {
            return Err("invalid drive letter");
        }
        let tail = value
            .get(3..)
            .ok_or("invalid drive path")?
            .trim_end_matches('\\');
        if !tail.is_empty() {
            for component in tail.split('\\') {
                if let Some(reason) = invalid_component(component) {
                    return Err(reason);
                }
            }
        }
        Ok(Self(format!(
            "{}:\\{}",
            char::from(*letter).to_ascii_lowercase(),
            tail.to_ascii_lowercase()
        )))
    }
    /// PATH entries may contain redundant interior separators. Preserve the prefix
    /// and every nonempty component so device paths, traversal and aliases still fail.
    pub fn search_directory(value: &str) -> Result<Self, &'static str> {
        let value = value.replace('/', "\\");
        let [letter, b':', b'\\', ..] = value.as_bytes() else {
            return Self::new(&value);
        };
        let tail = value[3..]
            .split('\\')
            .filter(|component| !component.is_empty())
            .collect::<Vec<_>>()
            .join("\\");
        Self::new(&format!("{}:\\{tail}", char::from(*letter)))
    }
    /// Privacy-safe error context; category is supplied by the caller, never a path.
    pub fn rejection(value: &str, category: &str, reason: &str) -> String {
        format!(
            "{category} path {} rejected: {reason}",
            super::probe::path_shape(&value.replace('/', "\\"))
        )
    }
    /// Strict parsing with a privacy-safe path category on failure.
    pub fn categorized(value: &str, category: &str) -> Result<Self, String> {
        Self::new(value).map_err(|reason| Self::rejection(value, category, reason))
    }
    /// The normalized spelling.
    pub fn as_str(&self) -> &str {
        &self.0
    }
    /// Whether the path is a whole drive.
    pub fn is_drive_root(&self) -> bool {
        self.0.len() == 3
    }
    /// Component-aware containment, including equality.
    pub fn is_within(&self, root: &Self) -> bool {
        self == root
            || self
                .0
                .strip_prefix(&root.0)
                .is_some_and(|tail| root.is_drive_root() || tail.starts_with('\\'))
    }
    /// Appends a relative path, retaining validation.
    pub fn join(&self, relative: &str) -> Result<Self, &'static str> {
        Self::new(&format!("{}\\{relative}", self.0.trim_end_matches('\\')))
    }
    /// Parent, or none for a drive root.
    pub fn parent(&self) -> Option<Self> {
        if self.is_drive_root() {
            return None;
        }
        let (parent, _) = self.0.rsplit_once('\\')?;
        Self::new(&format!("{parent}\\")).ok()
    }
}
fn invalid_component(name: &str) -> Option<&'static str> {
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if name.is_empty() {
        Some("empty path component")
    } else if matches!(name, "." | "..") {
        Some("relative path component")
    } else if name.ends_with(['.', ' ']) {
        Some("trailing dot or space")
    } else if short_alias(name) {
        Some("8.3 short-name spelling")
    } else if name
        .chars()
        .any(|c| c.is_control() || "<>:\"|?*".contains(c))
    {
        Some("invalid character or alternate data stream")
    } else if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix)
                .is_some_and(|n| matches!(n, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"))
        })
    {
        Some("reserved device name")
    } else {
        None
    }
}
/// An 8.3 alias such as `PROGRA~1` names the same entry as its long name,
/// so a lexical comparison could not tell that it is at or above a root.
fn short_alias(name: &str) -> bool {
    let (stem, extension) = name.rsplit_once('.').unwrap_or((name, ""));
    stem.len() <= 8
        && extension.len() <= 3
        && stem
            .rsplit_once('~')
            .is_some_and(|(_, n)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}
