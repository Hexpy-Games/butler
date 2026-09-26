use serde_json::Value;

use super::*;
use crate::models::parse_model_ref;

const DEFAULT_CONTEXT_WINDOW_TOKENS: f64 = 200_000.0;
const WARNING_THRESHOLD_RATIO: f64 = 0.70;
const AUTO_COMPACT_THRESHOLD_RATIO: f64 = 0.80;
const HARD_THRESHOLD_RATIO: f64 = 0.90;

fn positive_integer(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(value) => value
            .as_f64()
            .filter(|v| v.is_finite())
            .map(f64::trunc)
            .filter(|v| *v > 0.0),
        Value::String(value) if !crate::public_text::trim_js_whitespace(value).is_empty() => {
            Some(crate::json::number_from_string(value))
                .filter(|v| v.is_finite())
                .map(f64::trunc)
                .filter(|v| *v > 0.0)
        }
        _ => None,
    }
}

fn canonical_model_ref(value: Option<&str>) -> String {
    let raw = value
        .map(crate::public_text::trim_js_whitespace)
        .filter(|v| !v.is_empty())
        .unwrap_or("openai/gpt-5.5-codex");
    parse_model_ref(raw).canonical_ref
}

fn adaptive(window: f64, ratio: f64, min: f64, max: f64) -> f64 {
    let window = window.trunc().max(1.0);
    let max = max.min((window * 0.25).floor().max(128.0));
    let min = min.min(max);
    js_round(window * ratio).trunc().clamp(min, max)
}

fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

pub(crate) fn default_reserved_output_tokens(window: f64) -> f64 {
    adaptive(window, 0.125, 1_024.0, 8_000.0)
}
pub(crate) fn default_reserved_tool_tokens(window: f64) -> f64 {
    adaptive(window, 0.10, 1_024.0, 8_000.0)
}
pub(crate) fn default_compaction_prompt_reserve_tokens(window: f64) -> f64 {
    adaptive(window, 0.05, 768.0, 4_000.0)
}

impl ContextBudgetSnapshot<'_> {
    pub(crate) fn resolve(
        &self,
        model_ref: Option<&str>,
        overrides: &ContextBudgetOverrides,
    ) -> ContextBudgetConfig {
        let canonical = canonical_model_ref(model_ref);
        let system = self.config.pointer("/system");
        let override_by_model = overrides
            .model_windows
            .as_ref()
            .and_then(|map| map.get(&canonical));
        let config_by_model = system
            .and_then(|v| v.get("contextWindowTokensByModel"))
            .and_then(Value::as_object)
            .and_then(|map| map.get(&canonical));
        let env_window = self
            .environment
            .context_window_tokens
            .as_ref()
            .map(|v| Value::String(v.clone()));
        let metadata_window = self
            .models
            .resolve_model_metadata(Some(&canonical))
            .context_window_tokens;
        let window = positive_integer(overrides.context_window_tokens.as_ref())
            .or_else(|| positive_integer(override_by_model))
            .or_else(|| positive_integer(env_window.as_ref()))
            .or_else(|| positive_integer(config_by_model))
            .or_else(|| positive_integer(system.and_then(|v| v.get("contextWindowTokens"))))
            .or(metadata_window)
            .unwrap_or(DEFAULT_CONTEXT_WINDOW_TOKENS);
        let reserve = |override_value: Option<&Value>,
                       environment: &Option<String>,
                       key: &str,
                       fallback: fn(f64) -> f64| {
            let env = environment.as_ref().map(|v| Value::String(v.clone()));
            positive_integer(override_value)
                .or_else(|| positive_integer(env.as_ref()))
                .or_else(|| positive_integer(system.and_then(|v| v.get(key))))
                .unwrap_or_else(|| fallback(window))
        };
        ContextBudgetConfig {
            context_window_tokens: window,
            reserved_output_tokens: reserve(
                overrides.reserved_output_tokens.as_ref(),
                &self.environment.reserved_output_tokens,
                "contextReservedOutputTokens",
                default_reserved_output_tokens,
            ),
            reserved_tool_tokens: reserve(
                overrides.reserved_tool_tokens.as_ref(),
                &self.environment.reserved_tool_tokens,
                "contextReservedToolTokens",
                default_reserved_tool_tokens,
            ),
            warning_threshold_ratio: WARNING_THRESHOLD_RATIO,
            auto_compact_threshold_ratio: AUTO_COMPACT_THRESHOLD_RATIO,
            hard_threshold_ratio: HARD_THRESHOLD_RATIO,
        }
    }

    pub(crate) fn evaluate(
        &self,
        model_ref: Option<&str>,
        input_tokens: f64,
        overrides: &ContextBudgetOverrides,
    ) -> ContextBudgetEvaluation {
        let model_ref = canonical_model_ref(model_ref);
        let parsed = parse_model_ref(&model_ref);
        let config = self.resolve(Some(&model_ref), overrides);
        let input_tokens = input_tokens.trunc().max(0.0);
        let used_ratio = input_tokens / config.context_window_tokens;
        let hard = used_ratio >= config.hard_threshold_ratio;
        let compact = used_ratio >= config.auto_compact_threshold_ratio;
        let warn = used_ratio >= config.warning_threshold_ratio;
        let threshold_state = if hard {
            ContextThresholdState::HardPressure
        } else if compact {
            ContextThresholdState::AutoCompact
        } else if warn {
            ContextThresholdState::Warning
        } else {
            ContextThresholdState::Normal
        };
        let pressure_level = if compact || hard {
            ContextPressureLevel::High
        } else if warn {
            ContextPressureLevel::Medium
        } else {
            ContextPressureLevel::Low
        };
        let reserve = config.reserved_output_tokens + config.reserved_tool_tokens;
        let token_estimator = self
            .models
            .resolve_model_metadata(Some(&model_ref))
            .token_estimator;
        ContextBudgetEvaluation {
            free_tokens: (config.context_window_tokens - input_tokens).max(0.0),
            free_tokens_after_reserve: (config.context_window_tokens - reserve - input_tokens)
                .max(0.0),
            config,
            model_ref,
            provider_id: parsed.provider_id,
            model_id: parsed.model_id,
            input_tokens,
            token_estimator,
            used_ratio,
            threshold_state,
            pressure_level,
            should_warn: warn,
            should_auto_compact: compact,
            should_hard_pressure: hard,
        }
    }

    pub(crate) fn evaluate_working(
        &self,
        input: &WorkingContextBudgetInput,
    ) -> WorkingContextBudgetEvaluation {
        let model_ref = canonical_model_ref(input.model_ref.as_deref());
        let parsed = parse_model_ref(&model_ref);
        let config = self.resolve(Some(&model_ref), &input.overrides);
        let nonnegative = |v: f64| v.trunc().max(0.0);
        let static_tokens = nonnegative(input.static_context_tokens.unwrap_or(0.0));
        let live_tokens = nonnegative(input.live_configuration_tokens.unwrap_or(0.0));
        let runtime_tokens = nonnegative(input.runtime_state_tokens.unwrap_or(0.0));
        let env = self
            .environment
            .compaction_prompt_reserve_tokens
            .as_ref()
            .map(|v| Value::String(v.clone()));
        let reserve = nonnegative(
            input
                .compaction_prompt_reserve_tokens
                .or_else(|| positive_integer(env.as_ref()))
                .or_else(|| {
                    positive_integer(
                        self.config
                            .pointer("/system/contextCompactionPromptReserveTokens"),
                    )
                })
                .unwrap_or_else(|| {
                    default_compaction_prompt_reserve_tokens(config.context_window_tokens)
                }),
        );
        let available = (config.context_window_tokens
            - config.reserved_output_tokens
            - config.reserved_tool_tokens
            - static_tokens
            - live_tokens
            - runtime_tokens
            - reserve)
            .max(0.0);
        let working = nonnegative(input.working_context_tokens);
        let ratio = if available > 0.0 {
            working / available
        } else {
            1.0
        };
        let estimator = self
            .models
            .resolve_model_metadata(Some(&model_ref))
            .token_estimator;
        WorkingContextBudgetEvaluation {
            config,
            model_ref,
            provider_id: parsed.provider_id,
            model_id: parsed.model_id,
            token_estimator: estimator,
            working_context_tokens: working,
            static_context_tokens: static_tokens,
            live_configuration_tokens: live_tokens,
            runtime_state_tokens: runtime_tokens,
            compaction_prompt_reserve_tokens: reserve,
            available_working_context_tokens: available,
            used_working_ratio: ratio,
            should_auto_compact: ratio >= WORKING_CONTEXT_AUTO_COMPACT_RATIO,
            should_hard_pressure: ratio >= WORKING_CONTEXT_HARD_PRESSURE_RATIO
                || working > available,
            usable_user_message_tokens: available,
        }
    }

    pub(crate) fn default_recent_conversation_token_budget(&self, model_ref: Option<&str>) -> f64 {
        (self
            .resolve(model_ref, &ContextBudgetOverrides::default())
            .context_window_tokens
            * 0.05)
            .floor()
            .clamp(2_000.0, 16_000.0)
    }
}

pub(crate) struct WorkingContextBudgetInput {
    pub model_ref: Option<String>,
    pub working_context_tokens: f64,
    pub static_context_tokens: Option<f64>,
    pub live_configuration_tokens: Option<f64>,
    pub runtime_state_tokens: Option<f64>,
    pub compaction_prompt_reserve_tokens: Option<f64>,
    pub overrides: ContextBudgetOverrides,
}
