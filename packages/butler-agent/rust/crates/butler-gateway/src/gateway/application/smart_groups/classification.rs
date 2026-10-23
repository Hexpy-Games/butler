//! Classification request and strict reply parsing. Candidates reach the
//! model only under short ids; real node keys never leave the App.
use serde_json::{Map, Value, json};
use unicode_normalization::UnicodeNormalization;

use super::candidates::{Candidate, CandidateKind, Prepared};

const MESSAGE_CHARS: usize = 2000;
const TOPIC_GRAPHEMES: usize = 24;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum Target {
    None,
    Group(String),
    Conversation(String),
}

#[derive(Clone, Debug)]
pub(super) struct Classification {
    pub topic: Option<String>,
    pub target: Target,
}

pub(super) fn request(prepared: &Prepared) -> String {
    let message: String = prepared.text.chars().take(MESSAGE_CHARS).collect();
    let truncated = message.len() < prepared.text.len();
    let candidates = prepared
        .candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| {
            let id = (index + 1).to_string();
            match candidate.kind {
                CandidateKind::Group => {
                    json!({"id": id, "kind": "group", "title": candidate.title})
                }
                CandidateKind::Conversation => json!({"id": id, "kind": "conversation",
                    "title": candidate.title, "topic": candidate.topic}),
            }
        })
        .collect::<Vec<_>>();
    json!({"message": message, "truncated": truncated, "candidates": candidates}).to_string()
}

/// Exactly `topic`, `action` and `target`; anything else is no answer.
pub(super) fn parse(reply: &str, candidates: &[Candidate]) -> Option<Classification> {
    let value: Map<String, Value> = serde_json::from_str(reply.trim()).ok()?;
    if value.len() != 3 {
        return None;
    }
    let topic = match value.get("topic")? {
        Value::Null => None,
        Value::String(topic) => Some(valid_topic(topic)?),
        _ => return None,
    };
    let target = match value.get("target")? {
        Value::Null => None,
        Value::String(id) => Some(id.as_str()),
        _ => return None,
    };
    let chosen = |kind: CandidateKind| {
        let index = target?.parse::<usize>().ok()?.checked_sub(1)?;
        let candidate = candidates.get(index)?;
        (candidate.kind == kind && target == Some((index + 1).to_string().as_str()))
            .then(|| candidate.key.clone())
    };
    let target = match value.get("action")?.as_str()? {
        "none" if target.is_none() => Target::None,
        "join_group" => Target::Group(chosen(CandidateKind::Group)?),
        "group_sessions" => Target::Conversation(chosen(CandidateKind::Conversation)?),
        _ => return None,
    };
    Some(Classification { topic, target })
}

fn valid_topic(raw: &str) -> Option<String> {
    let topic = raw.trim();
    let graphemes = butler_core::segmentation::grapheme_segments(topic).count();
    (graphemes > 0 && graphemes <= TOPIC_GRAPHEMES && !topic.chars().any(char::is_control))
        .then(|| topic.to_owned())
}

/// Case- and compatibility-insensitive form used to match topics and titles.
pub(super) fn normalized(value: &str) -> String {
    value
        .nfkc()
        .collect::<String>()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
