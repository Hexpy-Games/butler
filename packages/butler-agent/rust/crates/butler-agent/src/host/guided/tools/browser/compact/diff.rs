//! A same-page observation as changes against the previous one. Elements are
//! keyed by ref (stable per element within a page epoch). Any reordering of
//! the remaining elements, or a change list over half the full size, falls
//! back to the full listing, so the model never infers stale layout.
use super::{Element, Line, Parsed, element_lines, elements, main_frame};
use std::collections::{HashMap, HashSet};

pub(super) fn render(
    previous: &Parsed,
    current: &Parsed,
    (previous_obs, obs): (&str, &str),
    full_text: &str,
) -> Option<String> {
    let before: HashMap<&str, &Element> = elements(previous)
        .map(|e| (e.reference.as_str(), e))
        .collect();
    let after: HashSet<&str> = elements(current).map(|e| e.reference.as_str()).collect();
    let kept_before: Vec<&str> = elements(previous)
        .map(|e| e.reference.as_str())
        .filter(|r| after.contains(r))
        .collect();
    let kept_after: Vec<&str> = elements(current)
        .map(|e| e.reference.as_str())
        .filter(|r| before.contains_key(r))
        .collect();
    if kept_before != kept_after {
        return None;
    }
    let changed: Vec<&Element> = elements(current)
        .filter(|e| before.get(e.reference.as_str()) != Some(e))
        .collect();
    let removed: Vec<&str> = elements(previous)
        .map(|e| e.reference.as_str())
        .filter(|r| !after.contains(r))
        .collect();
    let old_prose = prose(previous);
    let new_prose = prose(current);
    let added_prose: Vec<&str> = new_prose
        .iter()
        .filter(|line| !old_prose.contains(*line))
        .copied()
        .collect();
    let gone_prose = old_prose.iter().filter(|l| !new_prose.contains(*l)).count();
    let same = previous.lines == current.lines
        && previous.footer == current.footer
        && previous.field_list == current.field_list;
    let text = if same {
        unchanged(current, previous_obs, obs)
    } else {
        body(
            current,
            (previous_obs, obs),
            (&changed, &removed),
            (&added_prose, gone_prose),
        )
    };
    (text.len() * 2 <= full_text.len()).then_some(text)
}

fn prose(parsed: &Parsed) -> HashSet<&str> {
    parsed
        .lines
        .iter()
        .filter_map(|line| match line {
            Line::Prose(text) if !text.trim().is_empty() => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

/// Only a byte-identical page (apart from the observation id) is reported as
/// unchanged; any difference lists the changes.
fn unchanged(current: &Parsed, previous_obs: &str, obs: &str) -> String {
    let mut out = head(current);
    out.push(format!(
        "No change since {previous_obs}: the page content is identical, and its elements and refs still apply with observation {obs}."
    ));
    out.join("\n")
}

fn head(current: &Parsed) -> Vec<String> {
    Some(current.head.clone())
        .filter(|head| !head.is_empty())
        .into_iter()
        .collect()
}

fn body(
    current: &Parsed,
    (previous_obs, obs): (&str, &str),
    (changed, removed): (&[&Element], &[&str]),
    (added_prose, gone_prose): (&[&str], usize),
) -> String {
    let mut out = head(current);
    out.push(format!(
        "Changes since {previous_obs} on this page. Elements not listed are unchanged and keep their refs; act with observation {obs}. browser_observe with full:true lists everything."
    ));
    let main = main_frame(current);
    if !changed.is_empty() {
        out.push(format!("Changed or new elements ({}):", changed.len()));
        out.extend(element_lines(changed, main.as_deref()));
    }
    if !removed.is_empty() {
        out.push(format!("Removed elements: {}", removed.join(", ")));
    }
    if !added_prose.is_empty() {
        out.push("New text:".into());
        out.extend(added_prose.iter().map(|line| (*line).to_owned()));
    }
    if gone_prose > 0 {
        out.push(format!("{gone_prose} earlier text lines are gone."));
    }
    out.extend(current.footer.iter().cloned());
    out.join("\n")
}
