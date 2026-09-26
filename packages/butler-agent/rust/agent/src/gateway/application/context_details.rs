//! Derived App context diagnostics. Durable ownership stays with existing stores.

use serde_json::{Value, json};

use super::{
    AppApplication, AppContextReadQuery, AppSessionViewPage, GatewayApplicationError, app_error,
    settings,
};
use crate::{
    context::{WORKING_CONTEXT_AUTO_COMPACT_RATIO, WORKING_CONTEXT_HARD_PRESSURE_RATIO},
    gateway::MessageRole,
};

const MESSAGE_LIMIT: usize = 16;
const RECENT_CHAR_LIMIT: usize = 32_000;

impl AppApplication {
    pub(super) async fn context_details_owned(
        &self,
        session_id: String,
    ) -> Result<Value, GatewayApplicationError> {
        self.refresh_message_projection_owned(session_id.clone())
            .await?;
        let session = self.get_session(session_id.clone()).await?;
        let messages = self
            .message_window(
                session_id.clone(),
                AppSessionViewPage {
                    after_cursor: None,
                    before_cursor: None,
                    limit: MESSAGE_LIMIT,
                },
            )
            .await?
            .view
            .messages;
        let latest_turn = self.latest_session_turn(session_id.clone()).await?;
        let artifacts = self.artifact_page(session_id.clone()).await?;
        let facts = self.dependencies.settings_facts.snapshot()?;
        let subscribers = self.subscribers.clone();
        let now = self.dependencies.identity_clock.now_iso();
        let query_session = session_id.clone();
        let (controls, turn_count, file_count) = self
            .storage
            .execute(move |db| {
                let controls = settings::session_context_settings(
                    db,
                    &subscribers,
                    &facts,
                    &query_session,
                    &now,
                )?;
                let turn_count = db
                    .query_row(
                        "SELECT COUNT(*) FROM turns WHERE chat_id=?1",
                        [&query_session],
                        |row| row.get::<_, u64>(0),
                    )
                    .map_err(super::storage::AppStorageError::sqlite)?;
                let file_count = db
                    .query_row(
                        "SELECT COUNT(*) FROM message_files WHERE owner_session_id=?1",
                        [&query_session],
                        |row| row.get::<_, u64>(0),
                    )
                    .map_err(super::storage::AppStorageError::sqlite)?;
                Ok((controls, turn_count, file_count))
            })
            .await
            .map_err(app_error)?;
        let latest_started = latest_turn.as_ref().and_then(|turn| {
            chrono::DateTime::parse_from_rfc3339(&turn.created_at)
                .ok()
                .map(|value| value.timestamp_millis())
        });
        let host = self
            .dependencies
            .context_read
            .read(AppContextReadQuery {
                runtime_session_id: session.session_hint.clone(),
                turn_id: latest_turn.as_ref().map(|turn| turn.id.clone()),
                latest_turn_started_at_ms: latest_started,
                model_ref: controls.model.clone(),
                context_window_tokens: controls.context_window_tokens,
            })
            .await?;

        let data_root = self.butler_data.clone();
        let (persona_configured, eol_configured) = tokio::task::spawn_blocking(move || {
            (
                configured_text(&data_root.join("personas/active.md")),
                configured_text(&data_root.join("eol.md")),
            )
        })
        .await
        .map_err(|_| GatewayApplicationError::Internal)?;
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
            .map_or_else(|| tokens(&bounded_recent(&messages)), |_| 0);
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
        let budget = &host.budget;
        let available = budget.context_window_tokens.saturating_sub(
            budget.reserved_output_tokens
                + budget.reserved_tool_tokens
                + budget.compaction_prompt_reserve_tokens
                + static_tokens
                + live_tokens
                + runtime_tokens,
        );
        let used_working = working_tokens + retrieved_tokens + latest_input + reference_tokens;
        let working_ratio = if available == 0 {
            1.0
        } else {
            used_working as f64 / available as f64
        };
        let mut categories = vec![
            category(
                "static",
                "Static Context",
                static_tokens,
                "static_context",
                budget.context_window_tokens,
                "Stable runtime and role contract.",
            ),
            category(
                "live-config",
                "Live Configuration",
                live_tokens,
                "live_configuration",
                budget.context_window_tokens,
                "Latest EOL, persona, settings, rules, and profile projection.",
            ),
            category(
                "runtime-state",
                "Runtime State",
                runtime_tokens,
                "runtime_state",
                budget.context_window_tokens,
                "Protected session, project, transport, BTCC, worker, and task state.",
            ),
            category(
                "working",
                "Working Context",
                working_tokens,
                "working_context",
                budget.context_window_tokens,
                "Recent conversation suffix and current turn working material.",
            ),
            category(
                "retrieved",
                "Retrieved Context",
                retrieved_tokens,
                "retrieved_context",
                budget.context_window_tokens,
                "Hot cache, project memory, and latest compaction summary when present.",
            ),
            category(
                "current-input",
                "Current User Input",
                latest_input,
                "current_input",
                budget.context_window_tokens,
                "Latest inbound message and current attachment references.",
            ),
            category(
                "references",
                "References",
                reference_tokens,
                "references",
                budget.context_window_tokens,
                &format!(
                    "{} stable local reference(s).",
                    artifacts.len() as u64 + file_count
                ),
            ),
            category(
                "output-reserve",
                "Output Reserve",
                budget.reserved_output_tokens,
                "output_reserve",
                budget.context_window_tokens,
                "Reserved for the assistant response.",
            ),
            category(
                "tool-reserve",
                "Tool Reserve",
                budget.reserved_tool_tokens,
                "tool_reserve",
                budget.context_window_tokens,
                "Reserved for tool-call and tool-result growth.",
            ),
            category(
                "compaction-reserve",
                "Compaction Reserve",
                budget.compaction_prompt_reserve_tokens,
                "compaction_reserve",
                budget.context_window_tokens,
                "Reserved so auto-compaction can run before hard pressure.",
            ),
        ];
        if let Some(usage) = &host.usage {
            reconcile(&mut categories, usage.prompt_tokens);
        }
        let used = host
            .usage
            .as_ref()
            .map_or_else(|| occupied_total(&categories), |usage| usage.prompt_tokens);
        Ok(json!({
            "session_id":session_id,"model_ref":controls.model,
            "provider_id":controls.model.split_once('/').map(|v|v.0),
            "model_id":controls.model.split_once('/').map(|v|v.1),
            "token_count_source":host.usage.as_ref().map_or("character_estimate",|v|v.source.as_str()),
            "used_tokens":used,"budget_tokens":budget.context_window_tokens,
            "max_output_tokens":budget.max_output_tokens,
            "available_working_context_tokens":available,"used_working_context_tokens":used_working,
            "usable_user_message_tokens":available,
            "auto_compact_at_tokens":(available as f64 * WORKING_CONTEXT_AUTO_COMPACT_RATIO).floor() as u64,
            "hard_pressure_at_tokens":(available as f64 * WORKING_CONTEXT_HARD_PRESSURE_RATIO).floor() as u64,
            "ratio":if budget.context_window_tokens == 0 {0.0} else {used as f64 / budget.context_window_tokens as f64},
            "status":if working_ratio >= WORKING_CONTEXT_AUTO_COMPACT_RATIO {"high"} else if working_ratio >= 0.7 {"medium"} else {"low"},
            "categories":categories,"updated_at":self.dependencies.identity_clock.now_iso(),
        }))
    }
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
        .is_some_and(|value| !crate::public_text::trim_js_whitespace(&value).is_empty())
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
