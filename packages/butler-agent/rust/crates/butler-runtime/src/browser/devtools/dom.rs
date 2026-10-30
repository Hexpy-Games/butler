//! The walked document as indented tags, with every field value and attribute
//! decided here rather than in the page script.
use super::mask::{MASK, mask_text, mask_url};
use super::names::credential_name;
use serde_json::Value;

const OUTPUT_LIMIT: usize = 60_000;
const ATTRIBUTE_LIMIT: usize = 400;
const URL_ATTRIBUTES: &[&str] = &[
    "href",
    "src",
    "action",
    "formaction",
    "poster",
    "cite",
    "data",
    "ping",
    "background",
];
const SECRET_AUTOCOMPLETE: &[&str] = &["current-password", "new-password", "one-time-code"];
/// Inputs whose value the page wrote, not the person typing.
const SHOWN_INPUT_TYPES: &[&str] = &["button", "submit", "reset", "radio", "checkbox"];
/// What a selector may compare a value against: attributes always shown as
/// written. Comparing any other could reveal a masked value.
const COMPARABLE_ATTRIBUTES: &[&str] = &[
    "id",
    "class",
    "type",
    "name",
    "role",
    "for",
    "lang",
    "dir",
    "hidden",
    "disabled",
    "readonly",
    "required",
    "checked",
    "selected",
    "multiple",
    "rel",
    "target",
    "method",
    "enctype",
    "width",
    "height",
    "tabindex",
    "colspan",
    "rowspan",
    "aria-hidden",
    "aria-expanded",
    "aria-disabled",
    "aria-selected",
    "aria-checked",
    "aria-current",
    "aria-invalid",
    "aria-required",
    "aria-haspopup",
    "aria-controls",
    "aria-labelledby",
    "aria-describedby",
];

/// Whether a selector may be run: matching `[value^="a"]` would reveal a masked
/// value one character at a time, so an attribute value may only be compared
/// where the read shows it as written. An escape could spell any name.
pub fn selector_allowed(selector: &str) -> bool {
    if selector.contains('\\') {
        return false;
    }
    let mut rest = selector;
    while let Some(open) = rest.find('[') {
        rest = &rest[open + 1..];
        let mut quote = None;
        let mut end = rest.len();
        for (index, ch) in rest.char_indices() {
            match (quote, ch) {
                (None, '"' | '\'') => quote = Some(ch),
                (Some(open_quote), _) if ch == open_quote => quote = None,
                (None, ']') => {
                    end = index;
                    break;
                }
                _ => {}
            }
        }
        let inside = &rest[..end];
        if let Some((name, _)) = inside.split_once('=') {
            let name = name.trim_end_matches(['~', '|', '^', '$', '*']);
            let name = name
                .rsplit('|')
                .next()
                .unwrap_or(name)
                .trim()
                .to_ascii_lowercase();
            if !COMPARABLE_ATTRIBUTES.contains(&name.as_str()) {
                return false;
            }
        }
        rest = rest.get(end + 1..).unwrap_or("");
    }
    true
}

fn attribute<'a>(node: &'a Value, name: &str) -> &'a str {
    node["a"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|pair| {
            pair[0]
                .as_str()
                .is_some_and(|key| key.eq_ignore_ascii_case(name))
        })
        .and_then(|pair| pair[1].as_str())
        .unwrap_or("")
}

/// Whether a `value` is the page's own rather than something typed or filled
/// (a controlled field copies what is typed into this attribute). Everything
/// not known to be the page's own stays masked.
fn value_shown(node: &Value, tag: &str) -> bool {
    let shown_kind = match tag {
        "input" => SHOWN_INPUT_TYPES
            .iter()
            .any(|kind| attribute(node, "type").eq_ignore_ascii_case(kind)),
        "button" => true,
        _ => false,
    };
    let autocomplete = attribute(node, "autocomplete").to_ascii_lowercase();
    shown_kind
        && !SECRET_AUTOCOMPLETE
            .iter()
            .any(|name| autocomplete.contains(name))
        && !autocomplete.contains("cc-")
        && !credential_name(attribute(node, "name"))
        && !credential_name(attribute(node, "id"))
}

fn capped_attribute(value: &str) -> String {
    let total = value.chars().count();
    if total <= ATTRIBUTE_LIMIT {
        return value.to_owned();
    }
    let kept: String = value.chars().take(ATTRIBUTE_LIMIT).collect();
    format!("{kept}…[+{} chars]", total - ATTRIBUTE_LIMIT)
}

fn meta_secret(node: &Value) -> bool {
    ["name", "property", "http-equiv"]
        .iter()
        .any(|key| credential_name(attribute(node, key)))
}

/// One attribute as shown, or `None` when it is never shown.
fn shown_attribute(node: &Value, name: &str, value: &str) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    let tag = node["t"].as_str().unwrap_or("");
    if lower.starts_with("on") {
        return None;
    }
    if lower == "srcdoc" {
        return Some(MASK.to_owned());
    }
    if URL_ATTRIBUTES.contains(&lower.as_str()) {
        return Some(capped_attribute(&mask_url(value)));
    }
    if lower == "value" && !value_shown(node, tag) {
        return Some(MASK.to_owned());
    }
    if credential_name(&lower) || tag == "meta" && lower == "content" && meta_secret(node) {
        return Some(MASK.to_owned());
    }
    Some(capped_attribute(&mask_text(value)))
}

fn line(node: &Value) -> String {
    let depth = usize::try_from(node["d"].as_u64().unwrap_or(0)).unwrap_or(0);
    let indent = " ".repeat(depth.min(40));
    let Some(tag) = node["t"].as_str() else {
        let text = mask_text(node["x"].as_str().unwrap_or(""));
        let more = node["n"].as_u64().unwrap_or(0);
        return if more > 0 {
            format!("{indent}{text}…[+{more} chars]\n")
        } else {
            format!("{indent}{text}\n")
        };
    };
    let mut out = format!("{indent}<{tag}");
    for pair in node["a"].as_array().into_iter().flatten() {
        let (Some(name), Some(value)) = (pair[0].as_str(), pair[1].as_str()) else {
            continue;
        };
        if let Some(value) = shown_attribute(node, name, value) {
            out.push_str(&format!(" {name}=\"{}\"", value.replace('"', "&quot;")));
        }
    }
    out.push('>');
    if let Some(hidden) = node["hidden_chars"].as_u64() {
        out.push_str(&format!("[{hidden} chars not read]"));
    }
    out.push('\n');
    out
}

pub(crate) struct Rendered {
    pub(crate) html: String,
    pub(crate) rendered_nodes: usize,
    pub(crate) omitted_nodes: usize,
}

/// Renders within the output budget; what it leaves out is counted, never silent.
pub(crate) fn render(nodes: &[Value]) -> Rendered {
    let mut html = String::new();
    let mut rendered_nodes = 0;
    for node in nodes {
        let next = line(node);
        if html.len() + next.len() > OUTPUT_LIMIT {
            break;
        }
        html.push_str(&next);
        rendered_nodes += 1;
    }
    Rendered {
        html,
        rendered_nodes,
        omitted_nodes: nodes.len() - rendered_nodes,
    }
}
