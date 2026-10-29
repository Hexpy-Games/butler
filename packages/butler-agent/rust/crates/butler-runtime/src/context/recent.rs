use crate::context::ContextCode;
use crate::context::{ContextConversation, ContextResult, PromptMaterialRenderOptions};
pub(crate) mod history;
use butler_turn::btcc::ContextAssembly;

#[derive(Clone, Copy)]
pub(crate) struct RecentConversationInput<'a> {
    pub transport: &'a str,
    pub runtime_session_id: &'a str,
    pub model_ref: Option<&'a str>,
    pub event_id: Option<&'a str>,
    pub cognition: Option<&'a dyn crate::context::CognitionPromptPort>,
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
        if let Some(cognition) = input.cognition {
            let id = butler_turn::conversation::conversation_session_id_for_durable_session(
                input.runtime_session_id,
            );
            include_continuity(&mut assembly, cognition, &id, None).await?;
        }
        return Ok(assembly);
    };
    if let Some(cognition) = input.cognition {
        include_continuity(
            &mut assembly,
            cognition,
            &session.id,
            session.project_id.as_deref(),
        )
        .await?;
    }
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
    // SQL already selected whole turns with hysteresis. The legacy planner's
    // serialized-byte selector must not trim this window a second time; the
    // renderer below charges its final text with this model's token estimator.
    let options = render_options(f64::MAX, input.event_id);
    let plan = crate::context::compile_prompt_material_context_plan(&window.material, &options)?;
    let (content, visible) = history::render(
        &window,
        &plan,
        cap,
        &snapshot,
        input.model_ref,
        (&session.id, &owner.recent_history),
    )?;
    owner.store().record_visible_history(&session.id, visible);
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

async fn include_continuity(
    assembly: &mut ContextAssembly,
    cognition: &dyn crate::context::CognitionPromptPort,
    session_id: &str,
    project_id: Option<&str>,
) -> ContextResult<()> {
    let input = crate::context::PromptProjectionInput {
        session_id,
        project_id,
    };
    if let Some(content) = cognition.session_continuity(&input).await? {
        let index = assembly
            .retrieved_context
            .iter()
            .position(|s| s.id == "project-memory")
            .unwrap_or(assembly.retrieved_context.len());
        assembly.retrieved_context.insert(
            index,
            butler_turn::btcc::ContextSection {
                id: "session-continuity".into(),
                title: "Session Continuity".into(),
                content,
                region: Some("retrieved_context".into()),
                projection_class: "optional_hot_cache".into(),
                scope_kind: "session".into(),
                source: None,
            },
        );
    }
    Ok(())
}
