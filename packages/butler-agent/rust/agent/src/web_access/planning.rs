mod normalize;
mod prompt;

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{
    models::{ProviderPromptLifecycle, ProviderPromptPort, ProviderPromptRequest},
    web_access::{
        providers::contracts::SearchInput,
        service::{WebAccess, WebAccessError},
    },
};

pub(super) struct PlanningResult {
    pub plan: Option<SearchPlan>,
    pub used_planner: bool,
    pub attempts: usize,
    pub fallback_reason: Option<String>,
}

#[derive(Clone)]
pub(super) struct SearchPlan {
    pub depth: String,
    pub intent: String,
    pub scope: String,
    pub decomposition: Vec<SearchBucket>,
    pub queries: Vec<SearchQuery>,
    pub verification_required: bool,
    pub planner_attempts: usize,
}

#[derive(Clone)]
pub(super) struct SearchBucket {
    pub id: String,
    pub label: String,
    pub priority: String,
}

#[derive(Clone)]
pub(super) struct SearchQuery {
    pub bucket_id: Option<String>,
    pub query: String,
    pub purpose: String,
    pub priority: String,
    pub expected_source_type: Option<String>,
}

pub(super) async fn create_plan(
    access: &WebAccess,
    input: &SearchInput,
    turn_context: &str,
    cancellation: &CancellationToken,
) -> Result<PlanningResult, WebAccessError> {
    let config = access.config().unwrap_or_else(|_| json!({}));
    let planning = &config["webSearch"]["planning"];
    let enabled =
        planning["mode"].as_str() != Some("off") && planning["enabled"].as_bool().unwrap_or(true);
    if access.planning_disabled() || !enabled {
        return Ok(PlanningResult {
            plan: None,
            used_planner: false,
            attempts: 0,
            fallback_reason: Some(if access.planning_disabled() {
                "test search planning is disabled".into()
            } else {
                "search planning is disabled".into()
            }),
        });
    }
    let Some(provider) = access.prompt() else {
        return Ok(PlanningResult {
            plan: None,
            used_planner: false,
            attempts: 0,
            fallback_reason: Some("search planning provider is unavailable".into()),
        });
    };
    let depth = match planning["defaultDepth"].as_str() {
        Some("quick") => "quick",
        Some("deep") => "deep",
        _ => "balanced",
    };
    let timezone = config["user"]["timezone"]
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or(access.environment_value("TZ")?)
        .unwrap_or_else(|| "UTC".into());
    let model = config["webSearch"]["model"]
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let original = bounded_original_request(turn_context).unwrap_or_else(|| input.query.clone());
    let instructions = prompt::instructions();
    let mut last_error = None;
    for attempt in 1..=2 {
        if cancellation.is_cancelled() {
            return Err(WebAccessError::cancelled());
        }
        let body = prompt::build(
            input,
            &original,
            depth,
            &timezone,
            attempt,
            last_error.as_deref(),
        );
        let result = run_planner(
            provider.as_ref(),
            &body,
            instructions,
            model.as_deref(),
            cancellation,
        )
        .await;
        match result {
            Ok(text) => match normalize::parse_and_normalize(&text, depth) {
                Ok(mut plan) => {
                    plan.planner_attempts = attempt;
                    return Ok(PlanningResult {
                        plan: Some(plan),
                        used_planner: true,
                        attempts: attempt,
                        fallback_reason: None,
                    });
                }
                Err(error) => last_error = Some(error),
            },
            Err(error) if error.code == "cancelled" || cancellation.is_cancelled() => {
                return Err(WebAccessError::cancelled());
            }
            Err(_) => last_error = Some("planner request failed".into()),
        }
    }
    Ok(PlanningResult {
        plan: None,
        used_planner: true,
        attempts: 2,
        fallback_reason: Some(last_error.unwrap_or_else(|| "planner returned invalid JSON".into())),
    })
}

fn bounded_original_request(value: &str) -> Option<String> {
    let compact = compact_turn_context(value);
    if compact.is_empty() {
        return None;
    }
    let compact = if utf16_len(&compact) > 6_000 {
        format!(
            "{}\n...[truncated]\n{}",
            utf16_slice(&compact, 0, 4_000),
            utf16_tail(&compact, 2_000),
        )
    } else {
        compact
    };
    const MARKER: &str = "\n[...current turn context trimmed for search planner...]\n";
    if utf16_len(&compact) <= 3_000 {
        return Some(compact);
    }
    let head = crate::json::saturating_usize(((3_000 - utf16_len(MARKER)) as f64 * 0.7).floor());
    let tail = 3_000 - utf16_len(MARKER) - head;
    Some(format!(
        "{}{}{}",
        utf16_slice(&compact, 0, head).trim_end(),
        MARKER.trim(),
        utf16_tail(&compact, tail).trim_start(),
    ))
}

fn compact_turn_context(value: &str) -> String {
    let lines = value.lines().map(str::trim_end).collect::<Vec<_>>();
    lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| {
            if !line.trim().is_empty()
                || (index > 0
                    && index + 1 < lines.len()
                    && !lines[index - 1].trim().is_empty()
                    && !lines[index + 1].trim().is_empty())
            {
                Some(*line)
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn utf16_slice(value: &str, start: usize, end: usize) -> String {
    crate::json::Utf16Slice::new(value, start, end)
        .utf8_lossy()
        .into_owned()
}

fn utf16_tail(value: &str, count: usize) -> String {
    let length = utf16_len(value);
    utf16_slice(value, length.saturating_sub(count), length)
}

async fn run_planner(
    provider: &dyn ProviderPromptPort,
    prompt: &str,
    instructions: &str,
    model: Option<&str>,
    cancellation: &CancellationToken,
) -> Result<String, WebAccessError> {
    let result = provider
        .run_prompt(
            ProviderPromptRequest {
                prompt,
                model,
                reasoning_effort: None,
                instructions: Some(instructions),
                response_format: None,
                cache_scope: Some("smart-search-planning"),
                cache_boundary: None,
                cancellation: cancellation.clone(),
                attachments: &[],
                butler_data: None,
                usage_attribution: None,
                stream_observer: None,
                provider_retry_attempts: None,
            },
            ProviderPromptLifecycle::none(),
        )
        .await
        .map_err(|error| {
            if matches!(error, crate::models::ProviderPromptError::Cancelled) {
                return WebAccessError::cancelled();
            }
            WebAccessError::new(
                "web_search_planner_failed",
                "Smart search planning request failed.",
            )
        })?;
    Ok(result.text)
}

pub(super) fn compact(plan: &SearchPlan) -> Value {
    json!({
        "mode":"smart",
        "depth":plan.depth,
        "intent":plan.intent,
        "scope":plan.scope,
        "parallelizable":true,
        "verification_required":plan.verification_required,
        "planner_attempts":plan.planner_attempts,
        "decomposition":plan.decomposition.iter().map(|bucket| json!({
            "id":bucket.id,"label":bucket.label,"priority":bucket.priority,
        })).collect::<Vec<_>>(),
        "queries":plan.queries.iter().map(|query| json!({
            "bucket_id":query.bucket_id,
            "query":query.query,
            "purpose":query.purpose,
            "priority":query.priority,
            "expected_source_type":query.expected_source_type,
        })).collect::<Vec<_>>(),
    })
}
