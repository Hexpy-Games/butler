//! Observation text v2: the same elements and refs in fewer tokens, and a
//! same-page follow-up as changes against the view the model already holds.
//! Every rule is structural (roles, labels, frames, repeats), never per site.
mod diff;

use serde_json::{Value, json};

/// Diff chains are capped so a full listing stays near in the model's history.
const MAX_DELTA_DEPTH: u8 = 8;
/// A label this long repeated by a later element is referenced, not repeated.
const REPEAT_LABEL_CHARS: usize = 24;
const GEOMETRY_NOTE: &str = "Node rects and icon positions are CSS coordinates.";

/// One element line: `role "name" [ref]rest`.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Element {
    pub role: String,
    pub name: String,
    pub reference: String,
    pub rest: String,
}

impl Element {
    fn parse(line: &str) -> Option<Self> {
        let (role, after) = line.split_once(' ')?;
        if role.is_empty() || !role.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') {
            return None;
        }
        let mut stream = serde_json::Deserializer::from_str(after).into_iter::<String>();
        let name = stream.next()?.ok()?;
        let tail = after.get(stream.byte_offset()..)?.strip_prefix(" [")?;
        let (reference, rest) = tail.split_once(']')?;
        let valid = reference.starts_with('f') && reference.contains("-e");
        valid.then(|| Self {
            role: role.into(),
            name,
            reference: reference.into(),
            rest: rest.into(),
        })
    }

    fn line(&self, main_frame: Option<&str>) -> String {
        format!(
            "{} {} [{}]{}",
            self.role,
            Value::from(self.name.as_str()),
            self.reference,
            strip_frame(&self.rest, main_frame)
        )
    }
}

/// One line of observation text, in page order.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum Line {
    Element(Element),
    Prose(String),
}

/// An observation's text split into its parts.
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Parsed {
    pub head: String,
    pub geometry: Option<String>,
    pub field_list: Vec<String>,
    pub lines: Vec<Line>,
    pub footer: Option<String>,
}

pub(super) fn parse(text: &str) -> Parsed {
    let mut parsed = Parsed::default();
    let mut in_fields = false;
    for (index, line) in text.lines().enumerate() {
        if index == 0 && line.starts_with("tab ") {
            parsed.head = line.into();
        } else if line.starts_with(GEOMETRY_NOTE) {
            parsed.geometry = Some(line.into());
        } else if line.starts_with("Visible editable fields") {
            in_fields = true;
            parsed.field_list.push(line.into());
        } else if in_fields
            && line
                .split_once(". ")
                .is_some_and(|(n, _)| n.parse::<u32>().is_ok())
        {
            parsed.field_list.push(line.into());
        } else if line.starts_with("interactive ") && line.contains(" · below fold ") {
            parsed.footer = Some(line.into());
        } else if let Some(element) = Element::parse(line) {
            in_fields = false;
            parsed.lines.push(Line::Element(element));
        } else {
            in_fields = false;
            parsed.lines.push(Line::Prose(line.into()));
        }
    }
    parsed
}

pub(super) fn elements(parsed: &Parsed) -> impl Iterator<Item = &Element> {
    parsed.lines.iter().filter_map(|line| match line {
        Line::Element(element) => Some(element),
        Line::Prose(_) => None,
    })
}

/// The frame most elements name: its `frame=` suffix is stated once.
fn main_frame(parsed: &Parsed) -> Option<String> {
    let mut counts = std::collections::HashMap::<&str, usize>::new();
    for element in elements(parsed) {
        if let Some(frame) = frame_of(&element.rest) {
            *counts.entry(frame).or_default() += 1;
        }
    }
    counts
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(a.0)))
        .map(|(frame, _)| frame.to_owned())
}

fn frame_of(rest: &str) -> Option<&str> {
    let (_, frame) = rest.rsplit_once(" frame=")?;
    (!frame.is_empty() && !frame.contains(' ')).then_some(frame)
}

fn strip_frame(rest: &str, main_frame: Option<&str>) -> String {
    match (frame_of(rest), main_frame) {
        (Some(frame), Some(main)) if frame == main => {
            rest[..rest.len() - " frame=".len() - frame.len()].to_owned()
        }
        _ => rest.to_owned(),
    }
}

/// Compact element lines in page order. An image whose label repeats a
/// nearby element keeps only its ref; a long label repeated later points at
/// its first ref. No element and no ref is ever dropped.
pub(super) fn element_lines(lines: &[&Element], main_frame: Option<&str>) -> Vec<String> {
    let mut first = std::collections::HashMap::<&str, &str>::new();
    let mut recent: Vec<&str> = Vec::new();
    let mut out = Vec::with_capacity(lines.len());
    for element in lines {
        let rest = strip_frame(&element.rest, main_frame);
        let name = element.name.as_str();
        let echoes = element.role == "image"
            && !name.is_empty()
            && recent
                .iter()
                .rev()
                .take(3)
                .any(|label| label.contains(name));
        if echoes {
            out.push(format!("image [{}]{rest}", element.reference));
            continue;
        }
        if name.chars().count() >= REPEAT_LABEL_CHARS
            && let Some(earlier) = first.get(name)
        {
            out.push(format!(
                "{} ={earlier} [{}]{rest}",
                element.role, element.reference
            ));
            continue;
        }
        first.entry(name).or_insert(&element.reference);
        recent.push(name);
        out.push(element.line(main_frame));
    }
    out
}

/// The full compact text of an observation.
fn full_text(parsed: &Parsed, keep_geometry: bool, drop_field_list: bool) -> String {
    let main = main_frame(parsed);
    let mut out: Vec<String> = Some(parsed.head.clone())
        .filter(|head| !head.is_empty())
        .into_iter()
        .collect();
    if let Some(main) = &main {
        out.push(format!(
            "Elements are in frame={main} unless they name another frame."
        ));
    }
    if keep_geometry && let Some(geometry) = &parsed.geometry {
        out.push(geometry.clone());
    }
    if !drop_field_list {
        out.extend(parsed.field_list.iter().cloned());
    }
    let labels: std::collections::HashSet<&str> = elements(parsed).map(|e| e.name.trim()).collect();
    let mut batch: Vec<&Element> = Vec::new();
    for line in &parsed.lines {
        match line {
            Line::Element(element) => batch.push(element),
            Line::Prose(text) => {
                out.extend(element_lines(&batch, main.as_deref()));
                batch.clear();
                // Reading text that only repeats an element label adds nothing.
                if !labels.contains(text.trim()) {
                    out.push(text.clone());
                }
            }
        }
    }
    out.extend(element_lines(&batch, main.as_deref()));
    out.extend(parsed.footer.iter().cloned());
    out.join("\n")
}

/// What the model holds for a tab after an observation was encoded.
#[derive(Clone, Debug)]
pub(in crate::host::guided::tools) struct TabView {
    url: String,
    epoch: String,
    obs: String,
    parsed: Parsed,
    depth: u8,
}

fn head_field<'a>(head: &'a str, key: &str) -> &'a str {
    let mut words = head.split(' ');
    while let Some(word) = words.next() {
        if word == key {
            return words.next().unwrap_or("");
        }
    }
    ""
}

/// Rewrites a projected observation's `untrusted_content.text`. With the
/// tab's previous view on the same page and epoch it becomes a change list
/// (`delta_of`), unless `full`, the page changed too much, or the chain is
/// long. Returns the view the model holds afterwards.
pub(super) fn encode(
    result: &mut Value,
    previous: Option<&TabView>,
    full: bool,
) -> Option<TabView> {
    let content = &result["untrusted_content"];
    let text = content["text"].as_str()?;
    let url = content["url"].as_str().unwrap_or("").to_owned();
    let parsed = parse(text);
    let keep_geometry = result.get("image").is_some()
        || content["capture_regions"]
            .as_array()
            .is_some_and(|r| !r.is_empty());
    let has_fields = content["fields"].as_array().is_some_and(|f| !f.is_empty());
    let compact = full_text(&parsed, keep_geometry, has_fields);
    let epoch = head_field(&parsed.head, "epoch").to_owned();
    let obs = Some(head_field(&parsed.head, "obs"))
        .filter(|obs| !obs.is_empty())
        .or_else(|| result["obs"].as_str())
        .unwrap_or("")
        .to_owned();
    // A screenshot is a full view; listing changes only beside it would pin
    // its pixels in history as the base of later change lists.
    let screenshot = result.get("image").is_some();
    let base = previous.filter(|view| {
        !full
            && !screenshot
            && view.url == url
            && view.epoch == epoch
            && view.depth < MAX_DELTA_DEPTH
    });
    let delta =
        base.and_then(|view| diff::render(&view.parsed, &parsed, (&view.obs, &obs), &compact));
    let depth = match (&delta, base) {
        (Some(_), Some(view)) => view.depth + 1,
        _ => 0,
    };
    let encoded = match delta {
        Some(text) => {
            result["delta_of"] = json!(base.map(|view| view.obs.clone()));
            text
        }
        None => compact,
    };
    result["untrusted_content"]["text"] = json!(encoded);
    Some(TabView {
        url,
        epoch,
        obs,
        parsed,
        depth,
    })
}
