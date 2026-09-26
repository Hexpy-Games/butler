use crate::btcc::{ContextAssembly, ContextSection};
use crate::context::{ContextConversation, ContextResult, PromptMaterialRenderOptions};

pub(crate) struct RecentConversationInput<'a> {
    pub transport: &'a str,
    pub runtime_session_id: &'a str,
    pub model_ref: Option<&'a str>,
    pub event_id: Option<&'a str>,
}

pub(crate) fn recent_conversation_tail_limit(token_budget: f64) -> f64 {
    (token_budget / 80.0).ceil().clamp(20.0, 200.0)
}

pub(crate) async fn include_recent_context(
    owner: &ContextConversation,
    input: RecentConversationInput<'_>,
    mut assembly: ContextAssembly,
) -> ContextResult<ContextAssembly> {
    let Some(session) = owner
        .store()
        .get_session_by_gateway_binding(input.transport, input.runtime_session_id)
        .await
        .map_err(|e| {
            crate::context::ContextError::new("context_conversation_read_error", e.to_string())
        })?
    else {
        return Ok(assembly);
    };
    let snapshot = owner.budget().snapshot().await?;
    let token_budget = snapshot.default_recent_conversation_token_budget(input.model_ref);
    let material = owner
        .store()
        .read_prompt_material(
            &session.id,
            Some(recent_conversation_tail_limit(token_budget)),
        )
        .await
        .map_err(|e| {
            crate::context::ContextError::new("context_conversation_read_error", e.to_string())
        })?;
    let plan = crate::context::compile_prompt_material_context_plan(
        &material,
        &PromptMaterialRenderOptions {
            max_tokens: token_budget,
            exclude_source_ref: input.event_id.map(str::to_owned),
            exclude_turn_id: None,
            include_summaries: None,
            include_tools: None,
            current_request: None,
        },
    )?;
    let content = strip_heading(&plan.rendered);
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
    Ok(assembly)
}

fn strip_heading(value: &str) -> String {
    let value = value
        .strip_prefix("## Recent Conversation")
        .unwrap_or(value);
    crate::public_text::trim_js_whitespace(value).to_owned()
}
