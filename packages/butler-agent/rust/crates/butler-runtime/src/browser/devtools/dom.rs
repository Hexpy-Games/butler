//! The walked document as indented tags, with every field value and attribute
//! decided here rather than in the page script.
use super::mask::{MASK, credential_name, mask_text, mask_url};
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
/// Other tags whose `value` is the page's own. Any other tag may be a custom field.
const SHOWN_VALUE_TAGS: &[&str] = &[
    "option", "button", "li", "meter", "progress", "param", "data",
];
/// What a masked read may show as written: page structure, no page data. Any
/// other attribute keeps its name and loses its value.
const MASKED_READ_ATTRIBUTES: &[&str] = &[
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
/// not known to be the page's own stays masked, on every tab.
fn value_shown(node: &Value, tag: &str) -> bool {
    let shown_kind = match tag {
        "input" => SHOWN_INPUT_TYPES
            .iter()
            .any(|kind| attribute(node, "type").eq_ignore_ascii_case(kind)),
        _ => SHOWN_VALUE_TAGS.contains(&tag),
    };
    let autocomplete = attribute(node, "autocomplete").to_ascii_lowercase();
    shown_kind
        && !attribute(node, "type").eq_ignore_ascii_case("password")
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
fn shown_attribute(node: &Value, name: &str, value: &str, masked: bool) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    let tag = node["t"].as_str().unwrap_or("");
    if lower.starts_with("on") {
        return None;
    }
    if lower == "srcdoc" || lower == "srcset" && masked {
        return Some(MASK.to_owned());
    }
    if URL_ATTRIBUTES.contains(&lower.as_str()) {
        return Some(capped_attribute(&mask_url(value, masked)));
    }
    if masked && !MASKED_READ_ATTRIBUTES.contains(&lower.as_str()) {
        return Some(MASK.to_owned());
    }
    if lower == "value" && !value_shown(node, tag) {
        return Some(MASK.to_owned());
    }
    if credential_name(&lower) || tag == "meta" && lower == "content" && meta_secret(node) {
        return Some(MASK.to_owned());
    }
    Some(capped_attribute(&mask_text(value, masked)))
}

fn line(node: &Value, masked: bool) -> String {
    let depth = usize::try_from(node["d"].as_u64().unwrap_or(0)).unwrap_or(0);
    let indent = " ".repeat(depth.min(40));
    let Some(tag) = node["t"].as_str() else {
        let text = mask_text(node["x"].as_str().unwrap_or(""), masked);
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
        if let Some(value) = shown_attribute(node, name, value, masked) {
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
pub(crate) fn render(nodes: &[Value], masked: bool) -> Rendered {
    let mut html = String::new();
    let mut rendered_nodes = 0;
    for node in nodes {
        let next = line(node, masked);
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
