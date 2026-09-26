use serde_json::Value;
use sha2::{Digest, Sha256};

use super::super::{ConversationMessageWithParts, ConversationPart, ConversationPartKind};

#[derive(Debug)]
pub(crate) struct ConversationScalar<'a> {
    pub(crate) message: &'a ConversationMessageWithParts,
    pub(crate) part: &'a ConversationPart,
    pub(crate) pointer: String,
    pub(crate) text: &'a str,
    pub(crate) hash: String,
}

pub(crate) fn decode_message_scalars(
    message: &ConversationMessageWithParts,
) -> Vec<ConversationScalar<'_>> {
    let mut output = Vec::new();
    for part in &message.parts {
        match part.kind {
            ConversationPartKind::Text => {
                if let Some(text) = part
                    .content_json
                    .as_object()
                    .and_then(|value| value.get("text"))
                    .and_then(Value::as_str)
                {
                    push(&mut output, message, part, "/text".into(), text);
                }
            }
            ConversationPartKind::MessageContent => {
                if let Some(items) = part.content_json.as_array() {
                    for (index, item) in items.iter().enumerate() {
                        if let Some(text) = item
                            .as_object()
                            .and_then(|value| value.get("text"))
                            .and_then(Value::as_str)
                        {
                            push(&mut output, message, part, format!("/{index}/text"), text);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    output
}

pub(crate) fn scalar_for_part<'a>(part: &'a ConversationPart, pointer: &str) -> Option<&'a str> {
    if pointer == "/text" {
        return part
            .content_json
            .as_object()
            .and_then(|value| value.get("text"))
            .and_then(Value::as_str);
    }
    let digits = pointer.strip_prefix('/')?.strip_suffix("/text")?;
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let index = digits.parse::<usize>().ok()?;
    part.content_json
        .as_array()?
        .get(index)?
        .as_object()?
        .get("text")?
        .as_str()
}

fn push<'a>(
    output: &mut Vec<ConversationScalar<'a>>,
    message: &'a ConversationMessageWithParts,
    part: &'a ConversationPart,
    pointer: String,
    text: &'a str,
) {
    if text.is_empty() {
        return;
    }
    output.push(ConversationScalar {
        message,
        part,
        pointer,
        text,
        hash: format!("{:x}", Sha256::digest(text.as_bytes())),
    });
}
