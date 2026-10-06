use crate::context::ContextCode;
use crate::context::{ContextConversation, ContextResult, PromptMaterialRenderOptions};
mod history;
use butler_turn::btcc::{ContextAssembly, ContextSection};

pub(crate) struct RecentConversationInput<'a> {
    pub transport: &'a str,
    pub runtime_session_id: &'a str,
    pub model_ref: Option<&'a str>,
    pub event_id: Option<&'a str>,
}

pub(crate) async fn include_recent_context(
    owner: &ContextConversation,
    input: RecentConversationInput<'_>,
    mut assembly: ContextAssembly,
) -> ContextResult<ContextAssembly> {
    let started = std::time::Instant::now();
    let Some(session) = owner
        .store()
        .get_session_by_gateway_binding(input.transport, input.runtime_session_id)
        .await
        .map_err(|e| {
            crate::context::ContextError::new(
                ContextCode::ContextConversationReadError,
                e.to_string(),
            )
            .with_source(e)
        })?
    else {
        return Ok(assembly);
    };
    let snapshot = owner.budget().snapshot().await?;
    let token_budget = snapshot.default_recent_conversation_token_budget(input.model_ref);
    let cap = butler_core::json::saturating_usize(token_budget);
    let window = owner
        .store()
        .read_history_window(&session.id, cap)
        .await
        .map_err(|e| {
            crate::context::ContextError::new(
                ContextCode::ContextConversationReadError,
                e.to_string(),
            )
            .with_source(e)
        })?;
    let read_elapsed = started.elapsed();
    let window = history::summarize(owner, window, cap, &snapshot).await?;
    let summary_elapsed = started.elapsed().saturating_sub(read_elapsed);
    let material = &window.material;
    let plan = crate::context::compile_prompt_material_context_plan(
        material,
        &PromptMaterialRenderOptions {
            max_tokens: f64::MAX,
            exclude_source_ref: input.event_id.map(str::to_owned),
            exclude_turn_id: None,
            include_summaries: None,
            include_tools: None,
            current_request: None,
        },
    )?;
    let mut content = strip_heading(&plan.rendered);
    for turn in &material.turns {
        if window.late_turn_ids.contains(&turn.id)
            && let Some(timestamp) = &turn.completed_at
        {
            let header = format!("turn {} status {}", turn.id, turn.status);
            content = content.replacen(&header, &format!("{header} completed {timestamp}"), 1);
        }
    }
    if content.is_empty() {
        return Ok(assembly);
    }
    assembly.working_context.push(ContextSection {
        id: "recent-conversation".into(),
        title: "Recent Conversation".into(),
        content,
        region: Some("working_context".into()),
        projection_class: "mandatory_hot_cache".into(),
        scope_kind: "session".into(),
        source: None,
    });
    history::trace(started.elapsed(), read_elapsed, summary_elapsed).await;
    Ok(assembly)
}

fn strip_heading(value: &str) -> String {
    let value = value
        .strip_prefix("## Recent Conversation")
        .unwrap_or(value);
    butler_core::public_text::trim_js_whitespace(value).to_owned()
}
