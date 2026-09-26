//! Bounded host reads for App context diagnostics.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use serde_json::Value;

use crate::{
    btcc::ContextCompactionRepository,
    context::{ContextBudgetOverrides, ContextBudgetOwner, WorkingContextBudgetInput},
    gateway::{
        AppContextBudgetFacts, AppContextReadFacts, AppContextReadPort, AppContextReadQuery,
        AppContextUsage, ApplicationFuture, GatewayApplicationError,
    },
};

const MAX_COMPACTION_SUMMARY_CHARS: usize = 32_000;
use crate::json_lines::visit_json_lines;

pub(crate) struct NativeAppContextRead {
    data_root: PathBuf,
    budget: Arc<ContextBudgetOwner>,
    compactions: ContextCompactionRepository,
}

impl NativeAppContextRead {
    pub(crate) fn new(
        data_root: PathBuf,
        budget: Arc<ContextBudgetOwner>,
        compactions: ContextCompactionRepository,
    ) -> Self {
        Self {
            data_root,
            budget,
            compactions,
        }
    }
}

impl AppContextReadPort for NativeAppContextRead {
    fn read(&self, query: AppContextReadQuery) -> ApplicationFuture<AppContextReadFacts> {
        let root = self.data_root.clone();
        let budget = self.budget.clone();
        let compactions = self.compactions.clone();
        Box::pin(async move {
            let snapshot = budget
                .snapshot()
                .await
                .map_err(|_| GatewayApplicationError::Internal)?;
            let evaluated = snapshot.evaluate_working(WorkingContextBudgetInput {
                model_ref: Some(query.model_ref.clone()),
                working_context_tokens: 0.0,
                static_context_tokens: Some(0.0),
                live_configuration_tokens: Some(0.0),
                runtime_state_tokens: Some(0.0),
                compaction_prompt_reserve_tokens: None,
                overrides: ContextBudgetOverrides {
                    context_window_tokens: query.context_window_tokens.map(Value::from),
                    ..Default::default()
                },
            });
            let config = &evaluated.config;
            let metadata = snapshot
                .models
                .resolve_model_metadata(Some(&query.model_ref));
            let max_output = metadata
                .max_output_tokens
                .filter(|value| value.is_finite() && *value > 0.0)
                .map(|value| value.trunc() as u64);
            let telemetry_query = query.clone();
            let telemetry =
                tokio::task::spawn_blocking(move || read_usage(&root, &telemetry_query))
                    .await
                    .map_err(|_| GatewayApplicationError::Internal)?;
            let native_summary = match query.turn_id.as_deref() {
                Some(turn_id) => compactions
                    .load(turn_id)
                    .await
                    .map_err(|_| GatewayApplicationError::Internal)?
                    .first()
                    .map(|record| bounded_summary(&record.summary)),
                None => None,
            };
            let summary = native_summary.or(telemetry.compaction_summary);
            Ok(AppContextReadFacts {
                usage: telemetry.usage,
                compaction_summary: summary,
                budget: AppContextBudgetFacts {
                    context_window_tokens: config.context_window_tokens.max(0.0).trunc() as u64,
                    reserved_output_tokens: config.reserved_output_tokens.max(0.0).trunc() as u64,
                    reserved_tool_tokens: config.reserved_tool_tokens.max(0.0).trunc() as u64,
                    compaction_prompt_reserve_tokens: evaluated
                        .compaction_prompt_reserve_tokens
                        .max(0.0)
                        .trunc() as u64,
                    max_output_tokens: max_output,
                },
            })
        })
    }
}

struct Telemetry {
    usage: Option<AppContextUsage>,
    compaction_summary: Option<String>,
}

fn read_usage(root: &Path, query: &AppContextReadQuery) -> Telemetry {
    let scope = format!("btcc-guided:{}", query.runtime_session_id);
    let mut exact: Option<(i64, u64)> = None;
    let mut legacy: Option<(i64, u64)> = None;
    visit_json_lines(&root.join("metrics/prompt-cache-usage.jsonl"), |value| {
        let ts = value.get("ts").and_then(Value::as_i64).unwrap_or(-1);
        let prompt = positive_tokens(value.get("promptTokens"));
        if value.get("scope").and_then(Value::as_str) != Some(&scope) || prompt.is_none() {
            return;
        }
        if query
            .turn_id
            .as_deref()
            .is_some_and(|turn| value.get("turnId").and_then(Value::as_str) == Some(turn))
        {
            if exact.is_none_or(|current| ts >= current.0) {
                exact = Some((ts, prompt.unwrap()));
            }
        } else if value.get("turnId").is_none()
            && query
                .latest_turn_started_at_ms
                .is_some_and(|start| ts >= start)
            && legacy.is_none_or(|current| ts >= current.0)
        {
            legacy = Some((ts, prompt.unwrap()));
        }
    });
    let mut monitor: Option<(i64, u64)> = None;
    visit_json_lines(&root.join("metrics/context-monitor.jsonl"), |value| {
        let ts = value.get("ts").and_then(Value::as_i64).unwrap_or(-1);
        if value.get("kind").and_then(Value::as_str) != Some("runtime_turn")
            || value.get("sessionId").and_then(Value::as_str) != Some(&query.runtime_session_id)
            || query
                .latest_turn_started_at_ms
                .is_some_and(|start| ts < start)
            || value
                .get("model")
                .and_then(Value::as_str)
                .is_some_and(|model| model != query.model_ref)
        {
            return;
        }
        if let Some(chars) = value.get("totalPromptChars").and_then(Value::as_u64) {
            let tokens = chars.div_ceil(4);
            if tokens > 0 && monitor.is_none_or(|current| ts >= current.0) {
                monitor = Some((ts, tokens));
            }
        }
    });
    let usage = exact
        .map(|(_, tokens)| AppContextUsage {
            prompt_tokens: tokens,
            source: "provider_prompt_usage".into(),
        })
        .or_else(|| match (legacy, monitor) {
            (Some(left), Some(right)) if right.0 > left.0 => Some(AppContextUsage {
                prompt_tokens: right.1,
                source: "context_monitor".into(),
            }),
            (Some(left), _) => Some(AppContextUsage {
                prompt_tokens: left.1,
                source: "provider_prompt_usage".into(),
            }),
            (None, Some(right)) => Some(AppContextUsage {
                prompt_tokens: right.1,
                source: "context_monitor".into(),
            }),
            _ => None,
        });
    let safe = query
        .runtime_session_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let mut compaction_summary = None;
    visit_json_lines(
        &root
            .join("context/compactions")
            .join(format!("{safe}.jsonl")),
        |value| {
            if value.get("schema").and_then(Value::as_str) == Some("butler.context.compaction.v1")
                && value.get("status").and_then(Value::as_str) == Some("ok")
            {
                compaction_summary = value
                    .get("summary")
                    .and_then(Value::as_str)
                    .map(bounded_summary);
            }
        },
    );
    Telemetry {
        usage,
        compaction_summary,
    }
}

fn positive_tokens(value: Option<&Value>) -> Option<u64> {
    let value = value?.as_f64()?;
    (value.is_finite() && value > 0.0).then_some(value.round() as u64)
}

fn bounded_summary(value: &str) -> String {
    value.chars().take(MAX_COMPACTION_SUMMARY_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_turn_provider_usage_wins_over_newer_legacy_and_monitor_rows() {
        use std::io::Write;

        let root = std::env::temp_dir().join(format!(
            "butler-context-read-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join("metrics")).unwrap();
        let mut metrics =
            std::fs::File::create(root.join("metrics/prompt-cache-usage.jsonl")).unwrap();
        writeln!(metrics, "{{\"ts\":100,\"scope\":\"btcc-guided:runtime-a\",\"turnId\":\"turn-a\",\"promptTokens\":321}}").unwrap();
        for index in 0..18_000 {
            writeln!(metrics, "{{\"ts\":{},\"scope\":\"btcc-guided:other-session\",\"turnId\":\"other-{index}\",\"promptTokens\":88}}", 101 + index).unwrap();
        }
        writeln!(
            metrics,
            "{{\"ts\":30000,\"scope\":\"btcc-guided:runtime-a\",\"promptTokens\":999}}"
        )
        .unwrap();
        drop(metrics);
        assert!(
            std::fs::metadata(root.join("metrics/prompt-cache-usage.jsonl"))
                .unwrap()
                .len()
                > 1024 * 1024
        );
        std::fs::write(
            root.join("metrics/context-monitor.jsonl"),
            "{\"kind\":\"runtime_turn\",\"ts\":400,\"sessionId\":\"runtime-a\",\"model\":\"openai/test\",\"totalPromptChars\":8000}\n",
        ).unwrap();
        let telemetry = read_usage(
            &root,
            &AppContextReadQuery {
                runtime_session_id: "runtime-a".into(),
                turn_id: Some("turn-a".into()),
                latest_turn_started_at_ms: Some(0),
                model_ref: "openai/test".into(),
                context_window_tokens: None,
            },
        );
        assert_eq!(telemetry.usage.as_ref().unwrap().prompt_tokens, 321);
        assert_eq!(
            telemetry.usage.as_ref().unwrap().source,
            "provider_prompt_usage"
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
