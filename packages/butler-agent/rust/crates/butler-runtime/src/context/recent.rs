use crate::context::ContextCode;
use crate::context::{ContextConversation, ContextResult, PromptMaterialRenderOptions};
mod history;
use butler_turn::btcc::ContextAssembly;

#[derive(Clone, Copy)]
pub(crate) struct RecentConversationInput<'a> {
    pub transport: &'a str,
    pub runtime_session_id: &'a str,
    pub model_ref: Option<&'a str>,
    pub event_id: Option<&'a str>,
}

pub(crate) async fn include_recent_context(
    owner: &ContextConversation,
    input: RecentConversationInput<'_>,
    assembly: ContextAssembly,
) -> ContextResult<ContextAssembly> {
    assemble(owner, input, assembly).await
}

async fn assemble(
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

    let summary_elapsed = started.elapsed().saturating_sub(read_elapsed);
    let options = render_options(token_budget, input.event_id);
    let plan = crate::context::compile_prompt_material_context_plan(&window.material, &options)?;
    let content = history::render(&window, &plan, cap)?;
    if content.is_empty() {
        return Ok(assembly);
    }
    assembly.working_context.push(history::document(content)?);
    history::trace(started.elapsed(), read_elapsed, summary_elapsed).await;
    Ok(assembly)
}

fn render_options(max_tokens: f64, event_id: Option<&str>) -> PromptMaterialRenderOptions {
    PromptMaterialRenderOptions {
        max_tokens,
        exclude_source_ref: event_id.map(str::to_owned),
        exclude_turn_id: None,
        include_summaries: None,
        include_tools: None,
        current_request: None,
    }
}
