//! Roving focus and typeahead for the menu-like overlays (Radix `RovingFocusGroup`, the Menu
//! content key handler and its typeahead): Up and Down move the highlight without wrapping,
//! Home and End jump, a printable key searches item text with a one second buffer, Tab is
//! prevented. The functions take plain item data, so a menu and Select share them.
use std::time::{Duration, Instant};

/// The buffer of a typeahead search resets after this long without a key (`TYPEAHEAD`, 1s).
pub const TYPEAHEAD_RESET: Duration = Duration::from_millis(1000);

/// What a navigation key asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Intent {
    First,
    Last,
    Prev,
    Next,
}

/// `getFocusIntent` for a vertical group: Up/Down step, Home/PageUp and End/PageDown jump.
/// Left and Right are not navigation in a vertical list, and a key with Ctrl, Alt, Cmd or Shift
/// held (`modified`) is ignored.
pub fn intent(key: &str, modified: bool) -> Option<Intent> {
    if modified {
        return None;
    }
    match key {
        "up" => Some(Intent::Prev),
        "down" => Some(Intent::Next),
        "home" | "pageup" => Some(Intent::First),
        "end" | "pagedown" => Some(Intent::Last),
        _ => None,
    }
}

/// While the menu content itself holds focus (a pointer open), Down, PageUp and Home go to the
/// first item and Up, PageDown and End to the last (`FIRST_KEYS`, `LAST_KEYS` of Radix Menu).
pub fn content_intent(key: &str) -> Option<Intent> {
    match key {
        "down" | "pageup" | "home" => Some(Intent::First),
        "up" | "pagedown" | "end" => Some(Intent::Last),
        _ => None,
    }
}

/// The index the highlight moves to, skipping disabled items. `looping` wraps past either end
/// (Radix `loop`, off by default). `None` when nothing can take it.
pub fn target(
    disabled: &[bool],
    active: Option<usize>,
    intent: Intent,
    looping: bool,
) -> Option<usize> {
    let enabled = |i: &usize| !disabled.get(*i).copied().unwrap_or(true);
    let len = disabled.len();
    match intent {
        Intent::First => (0..len).find(enabled),
        Intent::Last => (0..len).rev().find(enabled),
        Intent::Next => {
            let from = active.map_or(0, |a| a + 1);
            let ahead = (from..len).find(enabled);
            ahead.or_else(|| {
                if looping {
                    (0..len).find(enabled)
                } else {
                    None
                }
            })
        }
        Intent::Prev => {
            let before = active.unwrap_or(len);
            let behind = (0..before).rev().find(enabled);
            behind.or_else(|| {
                if looping {
                    (0..len).rev().find(enabled)
                } else {
                    None
                }
            })
        }
    }
}

/// The running search text and when it last grew.
#[derive(Default)]
pub struct Typeahead {
    buffer: String,
    last: Option<Instant>,
}

impl Typeahead {
    /// Whether a search is running: keys were pushed less than a second ago. While it runs, a
    /// Space is part of the search and never selects (Radix: `searchRef.current !== ""`).
    pub fn running(&self, now: Instant) -> bool {
        !self.buffer.is_empty()
            && self
                .last
                .is_some_and(|at| now.saturating_duration_since(at) < TYPEAHEAD_RESET)
    }

    /// Adds `key` (one printable character) to the search and returns the item to highlight.
    /// `labels` are the enabled items' text; `current` the highlighted one's index into them.
    pub fn push(
        &mut self,
        key: &str,
        now: Instant,
        labels: &[&str],
        current: Option<usize>,
    ) -> Option<usize> {
        if self
            .last
            .is_some_and(|at| now.saturating_duration_since(at) >= TYPEAHEAD_RESET)
        {
            self.buffer.clear();
        }
        self.last = Some(now);
        self.buffer.push_str(key);
        next_match(labels, &self.buffer, current)
    }
}

/// Radix `getNextMatch`: a repeated single character cycles through the items starting with it;
/// otherwise the first item (from the current one on, wrapping) whose text starts with the search.
pub fn next_match(labels: &[&str], search: &str, current: Option<usize>) -> Option<usize> {
    let first = search.chars().next()?;
    let repeated = search.chars().count() > 1 && search.chars().all(|c| c == first);
    let needle: String = if repeated {
        first.to_lowercase().collect()
    } else {
        search.to_lowercase()
    };
    let start = current.unwrap_or(0);
    let exclude_current = needle.chars().count() == 1;
    let found = (0..labels.len())
        .map(|offset| (start + offset) % labels.len())
        .filter(|i| !(exclude_current && Some(*i) == current))
        .find(|i| labels[*i].to_lowercase().starts_with(&needle))?;
    (Some(found) != current).then_some(found)
}

/// A printable key a menu searches with: one character without Ctrl, Alt or Cmd (Radix:
/// `event.key.length === 1` and no modifier).
pub fn is_search_key(key: &str, control: bool, alt: bool, platform: bool) -> bool {
    key.chars().count() == 1 && !control && !alt && !platform
}
