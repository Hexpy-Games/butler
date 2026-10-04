//! Derived App context diagnostics. Durable ownership stays with existing stores.

use serde_json::{Value, json};

use super::{
    AppApplication, AppContextBudgetFacts, AppContextReadQuery, GatewayApplicationError, app_error,
};
use crate::gateway::MessageRole;
use butler_runtime::context::{
    WORKING_CONTEXT_AUTO_COMPACT_RATIO, WORKING_CONTEXT_HARD_PRESSURE_RATIO,
};
use butler_runtime::operations::SessionUsageView;

pub(super) mod records;
const RECENT_CHAR_LIMIT: usize = 32_000;

impl AppApplication {
    pub(super) async fn context_details_owned(
        &self,
        session_id: String,
    ) -> Result<ContextDetails, GatewayApplicationError> {
        self.refresh_baseline_projection(session_id.clone()).await?;
        let session = self.get_session(session_id.clone()).await?;
        let facts = self.dependencies.settings_facts.snapshot()?;
        let subscribers = self.subscribers.clone();
        let now = self.dependencies.identity_clock.now_iso();
        let query = session_id.clone();
        let records = self
            .storage
            .read(move |db| records::read(db, &query, &facts, &subscribers, &now))
            .await
            .map_err(app_error)?;
        self.project_context(session, records).await
    }

    pub(super) async fn project_context(
        &self,
        session: super::AppSessionSummary,
        records: records::Records,
    ) -> Result<ContextDetails, GatewayApplicationError> {
        let _measurement = self.storage.measure_view("context");
        let latest_turn = &records.latest_turn;
        let controls = &records.controls;
        let latest_started = latest_turn.as_ref().and_then(|turn| {
            chrono::DateTime::parse_from_rfc3339(&turn.created_at)
                .ok()
                .map(|value| value.timestamp_millis())
        });
        let host = self.dependencies.context_read.read(AppContextReadQuery {
            runtime_session_id: session.session_hint.clone(),
            turn_id: latest_turn.as_ref().map(|turn| turn.id.clone()),
            latest_turn_started_at_ms: latest_started,
            model_ref: controls.model.clone(),
            context_window_tokens: controls.context_window_tokens,
        });
        let host = async {
            let _measurement = self.storage.measure_view("context_host");
            host.await
        };

        let data_root = self.butler_data.clone();
        let storage = self.storage.clone();
        let configured = async move {
            let _measurement = storage.measure_view("context_configured");
            tokio::task::spawn_blocking(move || {
                (
                    configured_text(&data_root.join("personas/active.md")),
                    configured_text(&data_root.join("eol.md")),
                )
            })
            .await
            .map_err(GatewayApplicationError::internal_from)
        };
        let (host, (persona_configured, eol_configured)) = tokio::try_join!(host, configured)?;
        let counts = derive_tokens(
            &session,
            &records,
            &host,
            persona_configured,
            eol_configured,
        );
        Ok(render_context(
            &session,
            &records,
            host,
            counts,
            &self.dependencies.identity_clock.now_iso(),
        ))
    }
}

fn derive_tokens(
    session: &super::AppSessionSummary,
    records: &records::Records,
    host: &super::AppContextReadFacts,
    persona_configured: bool,
    eol_configured: bool,
) -> CategoryTokens {
    let records::Records {
        messages,
        artifacts,
        controls,
        turn_count,
        file_count,
        ..
    } = records;
    let static_tokens =
        tokens("Butler runtime contract, role policy, transport contract, and safety rules.");
    let live_tokens = tokens(&json!({
            "language":controls.language, "persona": if persona_configured {"configured"} else {"empty"},
            "eol": if eol_configured {"configured"} else {"empty"}, "model":controls.model,
            "access_mode":controls.access_mode, "plan_mode":controls.plan_mode,
        }).to_string());
    let runtime_tokens = tokens(
        &json!({
            "runtimeSessionId":session.session_hint, "projectId":session.project_id,
            "sessionKind":session.kind.as_str(), "turnCount":turn_count,
        })
        .to_string(),
    );
    let latest_input = messages
        .iter()
        .rev()
        .find(|message| matches!(message.role, MessageRole::User))
        .map_or(0, |message| bounded_tokens(&message.text));
    let recent_tokens = host
        .usage
        .as_ref()
        .map_or_else(|| tokens(&bounded_recent(messages)), |_| 0);
    let retrieved_tokens = host.compaction_summary.as_deref().map_or(0, tokens);
    let reference_tokens = artifacts.len() as u64 * 48 + file_count * 24;
    let known = static_tokens
        + live_tokens
        + runtime_tokens
        + retrieved_tokens
        + latest_input
        + reference_tokens;
    let working_tokens = host.usage.as_ref().map_or(recent_tokens, |usage| {
        usage.prompt_tokens.saturating_sub(known)
    });
    CategoryTokens {
        static_context: static_tokens,
        live_configuration: live_tokens,
        runtime_state: runtime_tokens,
        working: working_tokens,
        retrieved: retrieved_tokens,
        current_input: latest_input,
        references: reference_tokens,
        reference_count: artifacts.len() as u64 + file_count,
    }
}

fn render_context(
    session: &super::AppSessionSummary,
    records: &records::Records,
    host: super::AppContextReadFacts,
    counts: CategoryTokens,
    now: &str,
) -> ContextDetails {
    let budget = &host.budget;
    let available = budget.context_window_tokens.saturating_sub(
        budget.reserved_output_tokens
            + budget.reserved_tool_tokens
            + budget.compaction_prompt_reserve_tokens
            + counts.static_context
            + counts.live_configuration
            + counts.runtime_state,
    );
    let used_working = counts.working + counts.retrieved + counts.current_input + counts.references;
    let working_ratio = if available == 0 {
        1.0
    } else {
        used_working as f64 / available as f64
    };
    let mut categories = categories(budget, &counts);
    if let Some(usage) = &host.usage {
        reconcile(&mut categories, usage.prompt_tokens);
    }
    let used = host
        .usage
        .as_ref()
        .map_or_else(|| occupied_total(&categories), |usage| usage.prompt_tokens);
    let view = json!({
        "session_id":session.id,"model_ref":records.controls.model,"auth_mode":host.auth_mode,
        "provider_id":records.controls.model.split_once('/').map(|v|v.0),
        "model_id":records.controls.model.split_once('/').map(|v|v.1),
        "token_count_source":host.usage.as_ref().map_or("character_estimate",|v|v.source.as_str()),
        "used_tokens":used,"budget_tokens":budget.context_window_tokens,
        "max_output_tokens":budget.max_output_tokens,
        "available_working_context_tokens":available,"used_working_context_tokens":used_working,
        "usable_user_message_tokens":available,
        "auto_compact_at_tokens":butler_core::json::saturating_u64((available as f64 * WORKING_CONTEXT_AUTO_COMPACT_RATIO).floor()),
        "hard_pressure_at_tokens":butler_core::json::saturating_u64((available as f64 * WORKING_CONTEXT_HARD_PRESSURE_RATIO).floor()),
        "ratio":if budget.context_window_tokens == 0 {0.0} else {used as f64 / budget.context_window_tokens as f64},
        "status":if working_ratio >= WORKING_CONTEXT_AUTO_COMPACT_RATIO {"high"} else if working_ratio >= 0.7 {"medium"} else {"low"},
        "categories":categories,"updated_at":now,
    });
    ContextDetails {
        view,
        usage: host.session_usage,
    }
}

/// `ContextDetailsView` plus the session's usage for `SessionView.usage`.
pub(super) struct ContextDetails {
    pub(super) view: Value,
    pub(super) usage: Option<SessionUsageView>,
}

/// Token counts per context category, before reconciliation.
#[derive(Clone, Copy)]
struct CategoryTokens {
    static_context: u64,
    live_configuration: u64,
    runtime_state: u64,
    working: u64,
    retrieved: u64,
    current_input: u64,
    references: u64,
    reference_count: u64,
}

/// Context categories in display order: id, label, source kind, description.
/// The references description is rendered with the reference count.
const CATEGORIES: [(&str, &str, &str, &str); 10] = [
    (
        "static",
        "Static Context",
        "static_context",
        "Stable runtime and role contract.",
    ),
    (
        "live-config",
        "Live Configuration",
        "live_configuration",
        "Latest EOL, persona, settings, rules, and profile projection.",
    ),
    (
        "runtime-state",
        "Runtime State",
        "runtime_state",
        "Protected session, project, transport, BTCC, worker, and task state.",
    ),
    (
        "working",
        "Working Context",
        "working_context",
        "Recent conversation suffix and current turn working material.",
    ),
    (
        "retrieved",
        "Retrieved Context",
        "retrieved_context",
        "Hot cache, project memory, and latest compaction summary when present.",
    ),
    (
        "current-input",
        "Current User Input",
        "current_input",
        "Latest inbound message and current attachment references.",
    ),
    ("references", "References", "references", ""),
    (
        "output-reserve",
        "Output Reserve",
        "output_reserve",
        "Reserved for the assistant response.",
    ),
    (
        "tool-reserve",
        "Tool Reserve",
        "tool_reserve",
        "Reserved for tool-call and tool-result growth.",
    ),
    (
        "compaction-reserve",
        "Compaction Reserve",
        "compaction_reserve",
        "Reserved so auto-compaction can run before hard pressure.",
    ),
];

fn categories(budget: &AppContextBudgetFacts, tokens: &CategoryTokens) -> Vec<Value> {
    let used = [
        tokens.static_context,
        tokens.live_configuration,
        tokens.runtime_state,
        tokens.working,
        tokens.retrieved,
        tokens.current_input,
        tokens.references,
        budget.reserved_output_tokens,
        budget.reserved_tool_tokens,
        budget.compaction_prompt_reserve_tokens,
    ];
    let references = format!("{} stable local reference(s).", tokens.reference_count);
    CATEGORIES
        .iter()
        .zip(used)
        .map(|(&(id, label, kind, description), used)| {
            let description = if id == "references" {
                references.as_str()
            } else {
                description
            };
            category(
                id,
                label,
                used,
                kind,
                budget.context_window_tokens,
                description,
            )
        })
        .collect()
}

fn tokens(text: &str) -> u64 {
    text.encode_utf16().count().div_ceil(4) as u64
}

fn bounded_tokens(text: &str) -> u64 {
    text.encode_utf16()
        .take(RECENT_CHAR_LIMIT)
        .count()
        .div_ceil(4) as u64
}

fn configured_text(path: &std::path::Path) -> bool {
    std::fs::read_to_string(path)
        .ok()
        .is_some_and(|value| !butler_core::public_text::trim_js_whitespace(&value).is_empty())
}

fn bounded_recent(messages: &[crate::gateway::MessageRecord]) -> String {
    let mut parts = Vec::new();
    let mut remaining = RECENT_CHAR_LIMIT;
    for message in messages.iter().rev() {
        if remaining == 0 {
            break;
        }
        let prefix = format!(
            "{}: ",
            match message.role {
                MessageRole::User => "user",
                MessageRole::Assistant => "assistant",
                MessageRole::System => "system",
                MessageRole::SystemEvent => "system_event",
                MessageRole::ToolSummary => "tool_summary",
                MessageRole::Automation => "automation",
            }
        );
        let capacity = remaining.saturating_sub(prefix.chars().count() + 1);
        let suffix = message
            .text
            .chars()
            .rev()
            .take(capacity)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<String>();
        let part = format!("{prefix}{suffix}");
        remaining = remaining.saturating_sub(part.chars().count() + 1);
        parts.push(part);
    }
    parts.reverse();
    parts.join("\n")
}

fn category(id: &str, label: &str, used: u64, kind: &str, budget: u64, description: &str) -> Value {
    json!({"id":id,"label":label,"used_tokens":used,"budget_tokens":budget,
        "ratio":if budget==0 {0.0}else{used as f64/budget as f64},"safe_description":description,"source_kind":kind})
}
fn reserved(value: &Value) -> bool {
    matches!(
        value["source_kind"].as_str(),
        Some("output_reserve" | "tool_reserve" | "compaction_reserve")
    )
}
fn occupied_total(values: &[Value]) -> u64 {
    values
        .iter()
        .filter(|v| !reserved(v))
        .filter_map(|v| v["used_tokens"].as_u64())
        .sum()
}
fn reconcile(values: &mut [Value], target: u64) {
    let total = occupied_total(values);
    if total < target {
        if let Some(value) = values.iter_mut().find(|v| v["id"] == "working") {
            value["used_tokens"] =
                json!(value["used_tokens"].as_u64().unwrap_or(0) + target - total);
        }
    } else {
        let mut excess = total - target;
        for value in values.iter_mut().rev().filter(|v| !reserved(v)) {
            let used = value["used_tokens"].as_u64().unwrap_or(0);
            let take = used.min(excess);
            value["used_tokens"] = json!(used - take);
            excess -= take;
            if excess == 0 {
                break;
            }
        }
    }
    for value in values {
        let used = value["used_tokens"].as_u64().unwrap_or(0);
        let budget = value["budget_tokens"].as_u64().unwrap_or(0);
        value["ratio"] = json!(if budget == 0 {
            0.0
        } else {
            used as f64 / budget as f64
        });
    }
}
