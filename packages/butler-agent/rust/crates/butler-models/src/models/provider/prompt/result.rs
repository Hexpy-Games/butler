use serde_json::Value;

use crate::models::PromptUsageReport;

use super::super::serialize::Carrier;

pub(super) struct PromptDecoded {
    pub text: Option<String>,
    pub usage: Option<PromptUsageReport>,
    pub cache_write_tokens: Option<Option<f64>>,
}

pub(super) fn decode(response: &Value, model: &str, carrier: Carrier) -> PromptDecoded {
    let text = match carrier {
        Carrier::Responses => responses_text(response),
        Carrier::Anthropic => joined(response.pointer("/content"), true),
        Carrier::Gemini => joined(response.pointer("/candidates/0/content/parts"), false),
        Carrier::Chat { .. } => chat_text(response),
    };
    let stats = match carrier {
        Carrier::Responses => responses_usage(response),
        Carrier::Anthropic => {
            let prompt = number(response.pointer("/usage/input_tokens")).map(|value| {
                value
                    + number(response.pointer("/usage/cache_read_input_tokens")).unwrap_or(0.0)
                    + number(response.pointer("/usage/cache_creation_input_tokens")).unwrap_or(0.0)
            });
            usage_values(
                prompt,
                number(response.pointer("/usage/cache_read_input_tokens")),
                None,
                number(response.pointer("/usage/output_tokens")),
            )
        }
        Carrier::Gemini => usage(
            response.pointer("/usageMetadata/promptTokenCount"),
            response.pointer("/usageMetadata/cachedContentTokenCount"),
            response.pointer("/usageMetadata/totalTokenCount"),
            response.pointer("/usageMetadata/candidatesTokenCount"),
        ),
        Carrier::Chat { .. } => usage(
            response
                .pointer("/usage/prompt_tokens")
                .or_else(|| response.pointer("/usage/input_tokens")),
            response
                .pointer("/usage/prompt_tokens_details/cached_tokens")
                .or_else(|| response.pointer("/usage/input_tokens_details/cached_tokens")),
            response.pointer("/usage/total_tokens"),
            response
                .pointer("/usage/completion_tokens")
                .or_else(|| response.pointer("/usage/output_tokens")),
        ),
    };
    let cache_write = response
        .pointer("/usage/prompt_tokens_details/cache_write_tokens")
        .or_else(|| response.pointer("/usage/input_tokens_details/cache_write_tokens"));
    PromptDecoded {
        text,
        usage: stats.map(|stats| PromptUsageReport {
            model: model.into(),
            prompt_tokens: stats.prompt,
            cached_tokens: stats.cached,
            total_tokens: stats.total,
            output_tokens: stats.output,
        }),
        cache_write_tokens: cache_write.map(number_value),
    }
}

fn responses_usage(response: &Value) -> Option<Usage> {
    let prompt = number(
        response
            .pointer("/usage/input_tokens")
            .or_else(|| response.pointer("/usage/prompt_tokens")),
    );
    let cached = number(
        response
            .pointer("/usage/prompt_tokens_details/cached_tokens")
            .or_else(|| response.pointer("/usage/input_tokens_details/cached_tokens")),
    );
    let total = number(response.pointer("/usage/total_tokens"));
    let cache_write = number(
        response
            .pointer("/usage/prompt_tokens_details/cache_write_tokens")
            .or_else(|| response.pointer("/usage/input_tokens_details/cache_write_tokens")),
    );
    if prompt.is_none() && total.is_none() && cached.is_none() && cache_write.is_none() {
        return None;
    }
    Some(Usage {
        prompt,
        cached: cached.unwrap_or(0.0),
        total,
        output: match (total, prompt) {
            (Some(total), Some(prompt)) => (total - prompt).max(0.0),
            _ => 0.0,
        },
    })
}

struct Usage {
    prompt: Option<f64>,
    cached: f64,
    total: Option<f64>,
    output: f64,
}

fn usage(
    prompt: Option<&Value>,
    cached: Option<&Value>,
    total: Option<&Value>,
    output: Option<&Value>,
) -> Option<Usage> {
    usage_values(
        number(prompt),
        number(cached),
        number(total),
        number(output),
    )
}

fn usage_values(
    prompt: Option<f64>,
    cached: Option<f64>,
    total: Option<f64>,
    explicit_output: Option<f64>,
) -> Option<Usage> {
    if prompt.is_none() && total.is_none() {
        return None;
    }
    let output = explicit_output.unwrap_or_else(|| match (total, prompt) {
        (Some(total), Some(prompt)) => (total - prompt).max(0.0),
        _ => 0.0,
    });
    Some(Usage {
        prompt,
        cached: cached.unwrap_or(0.0),
        total: total.or_else(|| prompt.map(|value| value + output)),
        output,
    })
}

fn responses_text(value: &Value) -> Option<String> {
    value
        .get("output_text")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .and_then(super::super::result::nonempty)
        .or_else(|| {
            let output = value.get("output")?.as_array()?;
            super::super::result::nonempty(
                output
                    .iter()
                    .filter_map(|item| item.get("content").and_then(Value::as_array))
                    .flatten()
                    .filter(|item| item.get("type").and_then(Value::as_str) == Some("output_text"))
                    .filter_map(|item| item.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
        })
}

fn chat_text(value: &Value) -> Option<String> {
    let content = value.pointer("/choices/0/message/content")?;
    let text = if let Some(value) = content.as_str() {
        value.into()
    } else {
        content
            .as_array()?
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n")
    };
    super::super::result::nonempty(text)
}

fn joined(value: Option<&Value>, typed: bool) -> Option<String> {
    super::super::result::nonempty(
        value?
            .as_array()?
            .iter()
            .filter(|item| !typed || item.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

fn number(value: Option<&Value>) -> Option<f64> {
    value.and_then(number_value)
}

fn number_value(value: &Value) -> Option<f64> {
    value.as_f64().filter(|value| value.is_finite())
}

#[cfg(test)]
mod tests;
