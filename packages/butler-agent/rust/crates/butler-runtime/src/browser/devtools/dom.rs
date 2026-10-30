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
const VALUE_TAGS: &[&str] = &["input", "textarea", "option", "button", "param", "data"];

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

/// A field whose value is a secret whatever the tab: passwords, hidden inputs,
/// one-time codes, card fields and anything named like a credential.
fn secret_field(node: &Value) -> bool {
    let kind = attribute(node, "type").to_ascii_lowercase();
    let autocomplete = attribute(node, "autocomplete").to_ascii_lowercase();
    matches!(kind.as_str(), "password" | "hidden")
        || SECRET_AUTOCOMPLETE
            .iter()
            .any(|name| autocomplete.contains(name))
        || autocomplete.contains("cc-")
        || credential_name(attribute(node, "name"))
        || credential_name(attribute(node, "id"))
}

fn capped_attribute(value: &str) -> String {
    let total = value.chars().count();
    if total <= ATTRIBUTE_LIMIT {
        return value.to_owned();
    }
    let kept: String = value.chars().take(ATTRIBUTE_LIMIT).collect();
    format!("{kept}…[+{} chars]", total - ATTRIBUTE_LIMIT)
}

fn meta_secret(node: &Value, masked: bool) -> bool {
    masked
        || ["name", "property", "http-equiv"]
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
    if lower == "value" && VALUE_TAGS.contains(&tag) && (masked || secret_field(node)) {
        return Some(MASK.to_owned());
    }
    if credential_name(&lower) || tag == "meta" && lower == "content" && meta_secret(node, masked) {
        return Some(MASK.to_owned());
    }
    if masked && lower.starts_with("data-") {
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
