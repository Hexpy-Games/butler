//! Bounded host reads for App context diagnostics.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use serde_json::Value;

use butler_gateway::gateway::{
    AppContextBudgetFacts, AppContextReadFacts, AppContextReadPort, AppContextReadQuery,
    AppContextUsage, ApplicationFuture, GatewayApplicationError,
};
use butler_models::models::{
    ModelCatalog, ModelCatalogSnapshot, ProviderAuthMethod, ProviderAuthMode, UsageAuthMode,
    parse_model_ref,
};
use butler_runtime::context::{
    ContextBudgetOverrides, ContextBudgetOwner, WorkingContextBudgetInput,
};
use butler_runtime::operations::{SessionUsageIndex, SessionUsageView};
use butler_turn::btcc::ContextCompactionRepository;
use parking_lot::Mutex;

const MAX_COMPACTION_SUMMARY_CHARS: usize = 32_000;
mod telemetry;

pub(crate) struct AppContextRead {
    data_root: PathBuf,
    budget: Arc<ContextBudgetOwner>,
    compactions: ContextCompactionRepository,
    /// Session usage folded incrementally from the prompt-usage log.
    usage: Arc<Mutex<SessionUsageIndex>>,
    telemetry: Arc<Mutex<telemetry::Index>>,
}

impl AppContextRead {
    pub(crate) async fn for_runtime(
        runtime: &crate::host::runtime::AgentRuntime,
        data_root: &Path,
    ) -> Result<Self, butler_turn::btcc::BtccError> {
        Self::open(
            data_root.to_path_buf(),
            runtime.context_budget.clone(),
            runtime.context_compactions.clone(),
        )
        .await
    }
    async fn open(
        data_root: PathBuf,
        budget: Arc<ContextBudgetOwner>,
        compactions: ContextCompactionRepository,
    ) -> Result<Self, butler_turn::btcc::BtccError> {
        let root = data_root.clone();
        let catalog = budget.catalog().clone();
        let (telemetry, usage) = tokio::task::spawn_blocking(move || {
            let telemetry = telemetry::Index::open(&root);
            let mut usage = SessionUsageIndex::default();
            usage.read(&root, "", &|model| catalog.pricing(model));
            (telemetry, usage)
        })
        .await
        .map_err(|error| {
            butler_turn::btcc::BtccError::relayed(
                "app_context_index_open_failed",
                "Context telemetry initialization failed",
            )
            .with_source(error)
        })?;
        Ok(Self {
            data_root,
            budget,
            compactions,
            usage: Arc::new(Mutex::new(usage)),
            telemetry: Arc::new(Mutex::new(telemetry)),
        })
    }
}

impl AppContextReadPort for AppContextRead {
    fn read(&self, query: AppContextReadQuery) -> ApplicationFuture<AppContextReadFacts> {
        let root = self.data_root.clone();
        let budget = self.budget.clone();
        let compactions = self.compactions.clone();
        let usage = self.usage.clone();
        let telemetry_index = self.telemetry.clone();
        Box::pin(async move {
            let snapshot = budget
                .snapshot()
                .await
                .map_err(GatewayApplicationError::internal_from)?;
            let evaluated = snapshot.evaluate_working(&WorkingContextBudgetInput {
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
                .map(|value| butler_core::json::saturating_u64(value.trunc()));
            let telemetry_query = query.clone();
            let catalog = budget.catalog().clone();
            let configured = configured_auth_mode(&query.model_ref, &snapshot.models, &catalog);
            let (telemetry, session) = tokio::task::spawn_blocking(move || {
                let session = session_usage(&usage, &root, &telemetry_query, &catalog, configured);
                (
                    telemetry_index.lock().read(&root, &telemetry_query),
                    session,
                )
            })
            .await
            .map_err(GatewayApplicationError::internal_from)?;
            let native_summary = match query.turn_id.as_deref() {
                Some(turn_id) => compactions
                    .load(turn_id)
                    .await
                    .map_err(GatewayApplicationError::internal_from)?
                    .first()
                    .map(|record| bounded_summary(&record.summary)),
                None => None,
            };
            let summary = native_summary.or(telemetry.compaction_summary);
            Ok(AppContextReadFacts {
                usage: telemetry.usage,
                compaction_summary: summary,
                session_usage: Some(session.0),
                auth_mode: session.1,
                budget: AppContextBudgetFacts {
                    context_window_tokens: butler_core::json::saturating_u64(
                        config.context_window_tokens.max(0.0).trunc(),
                    ),
                    reserved_output_tokens: butler_core::json::saturating_u64(
                        config.reserved_output_tokens.max(0.0).trunc(),
                    ),
                    reserved_tool_tokens: butler_core::json::saturating_u64(
                        config.reserved_tool_tokens.max(0.0).trunc(),
                    ),
                    compaction_prompt_reserve_tokens: butler_core::json::saturating_u64(
                        evaluated.compaction_prompt_reserve_tokens.max(0.0).trunc(),
                    ),
                    max_output_tokens: max_output,
                },
            })
        })
    }
}

/// The session's usage view and how its current model is billed: as its
/// latest request of that model reported, else as configured.
fn session_usage(
    index: &Mutex<SessionUsageIndex>,
    root: &Path,
    query: &AppContextReadQuery,
    catalog: &ModelCatalog,
    configured: UsageAuthMode,
) -> (SessionUsageView, UsageAuthMode) {
    let pricing = |model_ref: &str| catalog.pricing(model_ref);
    let usage = index.lock().read(root, &query.runtime_session_id, &pricing);
    let mode = usage
        .auth_modes
        .get(&query.model_ref)
        .copied()
        .unwrap_or(configured);
    (usage.view, mode)
}

/// Billing mode from configuration when no request has reported one yet.
fn configured_auth_mode(
    model_ref: &str,
    models: &ModelCatalogSnapshot,
    catalog: &ModelCatalog,
) -> UsageAuthMode {
    let provider = parse_model_ref(model_ref).provider_id;
    let registered = models
        .view()
        .registered_models
        .iter()
        .find(|model| model.model_ref == model_ref)
        .and_then(|model| model.auth_type);
    let auth = match registered {
        _ if provider == "local" => ProviderAuthMode::None,
        Some(ProviderAuthMethod::ApiKey) => ProviderAuthMode::ApiKey,
        Some(ProviderAuthMethod::CodexOauth) => ProviderAuthMode::CodexOauth,
        None => ProviderAuthMode::None,
    };
    catalog.usage_auth_mode(&provider, auth)
}

struct Telemetry {
    usage: Option<AppContextUsage>,
    compaction_summary: Option<String>,
}

fn positive_tokens(value: Option<&Value>) -> Option<u64> {
    let value = value?.as_f64()?;
    (value.is_finite() && value > 0.0).then_some(butler_core::json::saturating_u64(value.round()))
}

fn bounded_summary(value: &str) -> String {
    value.chars().take(MAX_COMPACTION_SUMMARY_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // test-category: pure-logic
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
        let telemetry = telemetry::Index::open(&root).read(
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
