use crate::public_text::fixed_regex::fixed_regex;
use std::{collections::HashSet, sync::LazyLock};

use regex::Regex;
use serde_json::{Map, Value};

use crate::btcc::{ModelRoundRequest, ModelRoundToolCall, ToolCallOrigin};

pub(super) fn decode(
    response: &Value,
    request: &ModelRoundRequest<'_>,
) -> (Option<String>, Vec<ModelRoundToolCall>, Vec<String>) {
    let message = response
        .pointer("/choices/0/message")
        .unwrap_or(&Value::Null);
    let raw = assistant_raw_text(message);
    let raw = crate::public_text::trim_js_whitespace(&raw);
    let allowed = request
        .tools
        .iter()
        .map(|tool| tool.name.as_str())
        .collect::<HashSet<_>>();
    let structured = message.get("tool_calls").and_then(Value::as_array);
    let calls = if let Some(calls) = structured.filter(|calls| !calls.is_empty()) {
        calls
            .iter()
            .filter_map(|value| {
                let name = normalize(value.pointer("/function/name")?.as_str()?, &allowed)?;
                let mut call = super::call(
                    value.get("id"),
                    Some(&Value::String(name)),
                    value.pointer("/function/arguments"),
                )?;
                call.origin = Some(ToolCallOrigin::Native);
                Some(call)
            })
            .collect()
    } else {
        text_calls(raw, &allowed)
    };
    let visible = sanitize(raw);
    let names = if calls
        .iter()
        .any(|call| call.origin == Some(ToolCallOrigin::Text))
    {
        Vec::new()
    } else {
        standalone_names(&visible, &allowed)
    };
    (super::nonempty(visible), calls, names)
}

fn text_calls(text: &str, allowed: &HashSet<&str>) -> Vec<ModelRoundToolCall> {
    if text.len() > 64_000 {
        return Vec::new();
    }
    call_bodies(text)
        .into_iter()
        .take(8)
        .enumerate()
        .filter_map(|(index, body)| parse_body(body, allowed, index + 1))
        .collect()
}

fn parse_body(body: &str, allowed: &HashSet<&str>, index: usize) -> Option<ModelRoundToolCall> {
    let body = crate::public_text::trim_js_whitespace(body);
    if body.is_empty() || body.len() > 20_000 {
        return None;
    }
    static CALL: LazyLock<Regex> = LazyLock::new(|| {
        fixed_regex(
            r"(?is)^call\s*:\s*([A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)*)\s*(.*)$",
        )
    });
    let (name, arguments) = if let Some(captures) = CALL.captures(body) {
        let name = normalize(captures.get(1)?.as_str(), allowed)?;
        if !allowed.is_empty() && !allowed.contains(name.as_str()) {
            return None;
        }
        let remainder = captures.get(2).map_or("", |value| value.as_str());
        let arguments = if crate::public_text::trim_js_whitespace(remainder).is_empty() {
            Map::new()
        } else {
            object_in(remainder)?
        };
        (name, arguments)
    } else {
        let parsed = jsonish(body)?;
        let function = parsed.get("function").and_then(Value::as_object);
        let raw_name = [
            parsed.get("name"),
            parsed.get("tool_name"),
            parsed.get("tool"),
            parsed.get("function"),
            function.and_then(|value| value.get("name")),
        ]
        .into_iter()
        .flatten()
        .find_map(Value::as_str)?;
        let name = normalize(raw_name, allowed)?;
        if !allowed.is_empty() && !allowed.contains(name.as_str()) {
            return None;
        }
        let arguments = parsed
            .get("arguments")
            .or_else(|| parsed.get("args"))
            .or_else(|| parsed.get("parameters"))
            .or_else(|| function.and_then(|value| value.get("arguments")))
            .or_else(|| function.and_then(|value| value.get("args")))
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new()));
        (name, arguments.as_object().cloned().unwrap_or_default())
    };
    let raw = crate::json::stringify(&Value::Object(arguments.clone())).ok()?;
    Some(ModelRoundToolCall {
        id: format!("local_text_call_{index}"),
        name,
        arguments,
        raw_arguments: raw,
        origin: Some(ToolCallOrigin::Text),
    })
}

fn object_in(value: &str) -> Option<Map<String, Value>> {
    let start = value.find('{')?;
    let end = value.rfind('}')?;
    jsonish(&value[start..=end])
}

fn jsonish(value: &str) -> Option<Map<String, Value>> {
    let value = crate::public_text::trim_js_whitespace(value);
    if value.is_empty() || value.len() > 8_000 || !value.starts_with('{') || !value.ends_with('}') {
        return None;
    }
    serde_json::from_str::<Value>(value)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .or_else(|| {
            static KEYS: LazyLock<Regex> =
                LazyLock::new(|| fixed_regex(r"([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:"));
            static COMMAS: LazyLock<Regex> = LazyLock::new(|| fixed_regex(r",\s*([}\]])"));
            let normalized = KEYS.replace_all(value, "$1\"$2\":");
            let normalized = COMMAS.replace_all(&normalized, "$1");
            serde_json::from_str::<Value>(&normalized)
                .ok()
                .and_then(|value| value.as_object().cloned())
        })
}

fn normalize(value: &str, allowed: &HashSet<&str>) -> Option<String> {
    let value = crate::public_text::trim_js_whitespace(value);
    if value.is_empty() {
        return None;
    }
    let final_segment = value
        .split(':')
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
        .next_back()
        .unwrap_or(value);
    Some(
        if allowed.contains(value) {
            value
        } else {
            final_segment
        }
        .into(),
    )
}

fn call_bodies(text: &str) -> Vec<&str> {
    let mut output = Vec::new();
    let mut cursor = 0;
    while let Some((start, marker)) = first(
        text,
        cursor,
        &["<|tool_call>", "<|tool_call|>", "<tool_call>"],
    ) {
        let body = start + marker.len();
        let Some((end, close)) = first(
            text,
            body,
            &["<tool_call|>", "<|/tool_call|>", "</tool_call>"],
        ) else {
            break;
        };
        output.push(&text[body..end]);
        cursor = end + close.len();
    }
    output
}

fn strip_call_blocks(text: &str) -> String {
    let mut output = String::new();
    let mut cursor = 0;
    while cursor < text.len() {
        let Some((start, marker)) = first(
            text,
            cursor,
            &["<|tool_call>", "<|tool_call|>", "<tool_call>"],
        ) else {
            output.push_str(&text[cursor..]);
            break;
        };
        output.push_str(&text[cursor..start]);
        let body = start + marker.len();
        let Some((end, close)) = first(
            text,
            body,
            &["<tool_call|>", "<|/tool_call|>", "</tool_call>"],
        ) else {
            break;
        };
        cursor = end + close.len();
        if cursor == text.len() {
            break;
        }
    }
    output
}

fn standalone_names(text: &str, allowed: &HashSet<&str>) -> Vec<String> {
    if text.len() > 64_000 {
        return Vec::new();
    }
    static FENCE: LazyLock<Regex> = LazyLock::new(|| fixed_regex(r"(?s)```.*?```|~~~.*?~~~"));
    let masked = FENCE.replace_all(text, "");
    allowed
        .iter()
        .filter(|name| {
            // The name is escaped, so only the regex size limit could reject it.
            Regex::new(&format!(r"(?:^|[^A-Za-z0-9_]){}\s*\(", regex::escape(name)))
                .is_ok_and(|call| call.is_match(&masked))
        })
        .map(|value| (*value).to_owned())
        .collect()
}

fn assistant_raw_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn sanitize(raw: &str) -> String {
    let mut text = raw.replace("\r\n", "\n").replace('\r', "\n");
    let scan = mask_fences(&text);
    let has_reasoning = reasoning_signal(&scan);
    if let Some(start) = final_marker_end(&scan, has_reasoning) {
        text = text[start..].to_owned();
    }
    let (mut text, fences) = preserve_fences(&text);
    static THINK: LazyLock<Regex> =
        LazyLock::new(|| fixed_regex(r"(?is)<think\b[^>]*>.*?</think>|<think\b[^>]*>.*$"));
    static PROTOCOL: LazyLock<Regex> = LazyLock::new(|| {
        fixed_regex(
            r"(?is:<\|[^>]*\|>|</?s>|</?(?:channel|message|start|end|analysis|final)\|[^>]*>)",
        )
    });
    static REASONING_LINE: LazyLock<Regex> =
        LazyLock::new(|| fixed_regex(r"(?im)^\s*(?:analysis|reasoning)\s*:\s*$"));
    text = THINK.replace_all(&text, "").into_owned();
    text = strip_call_blocks(&text);
    text = PROTOCOL.replace_all(&text, "").into_owned();
    if has_reasoning {
        text = REASONING_LINE.replace_all(&text, "").into_owned();
    }
    text = restore_fences(&text, &fences);
    let mut output = text
        .split('\n')
        .map(|line| line.trim_end_matches([' ', '\t']))
        .collect::<Vec<_>>()
        .join("\n");
    while output.contains("\n\n\n") {
        output = output.replace("\n\n\n", "\n\n");
    }
    crate::public_text::trim_js_whitespace(&output).to_owned()
}

fn mask_fences(text: &str) -> String {
    static FENCE: LazyLock<Regex> = LazyLock::new(|| fixed_regex(r"(?s)```.*?```|~~~.*?~~~"));
    FENCE
        .replace_all(text, |capture: &regex::Captures<'_>| {
            " ".repeat(capture[0].len())
        })
        .into_owned()
}

fn preserve_fences(text: &str) -> (String, Vec<String>) {
    static FENCE: LazyLock<Regex> = LazyLock::new(|| fixed_regex(r"(?s)```.*?```|~~~.*?~~~"));
    let mut fences = Vec::new();
    let output = FENCE
        .replace_all(text, |capture: &regex::Captures<'_>| {
            let index = fences.len();
            fences.push(capture[0].to_owned());
            format!("\u{e000}{index}\u{e001}")
        })
        .into_owned();
    (output, fences)
}

fn restore_fences(text: &str, fences: &[String]) -> String {
    static TOKEN: LazyLock<Regex> = LazyLock::new(|| fixed_regex("\\u{e000}([0-9]+)\\u{e001}"));
    TOKEN
        .replace_all(text, |capture: &regex::Captures<'_>| {
            capture[1]
                .parse::<usize>()
                .ok()
                .and_then(|index| fences.get(index))
                .cloned()
                .unwrap_or_default()
        })
        .into_owned()
}

fn reasoning_signal(text: &str) -> bool {
    static SIGNAL: LazyLock<Regex> = LazyLock::new(|| {
        fixed_regex(
            r"(?im)<think\b|<\|channel\|analysis\|>|<channel\|analysis>|(?:^|\n)\s*(?:analysis|reasoning)\s*:",
        )
    });
    SIGNAL.is_match(text)
}

fn final_marker_end(text: &str, allow_text: bool) -> Option<usize> {
    static FINAL: LazyLock<Regex> =
        LazyLock::new(|| fixed_regex(r"(?i:<\|channel\|final\|>|<channel\|final>)"));
    let mut latest = FINAL.find_iter(text).map(|found| found.end()).max();
    if allow_text {
        static TEXT_FINAL: LazyLock<Regex> =
            LazyLock::new(|| fixed_regex(r"(?im)(?:^|\n)\s*(?:final|assistant_final)\s*:"));
        latest = latest.max(TEXT_FINAL.find_iter(text).map(|found| found.end()).max());
    }
    latest
}

fn first<'a>(text: &'a str, start: usize, markers: &[&'a str]) -> Option<(usize, &'a str)> {
    markers
        .iter()
        .filter_map(|marker| {
            text[start..]
                .find(marker)
                .map(|index| (start + index, *marker))
        })
        .min_by_key(|(index, _)| *index)
}
