use super::{GuidedTextState, documents, phase_memory};
use butler_turn::btcc::{BtccError, GuidedInvocation, GuidedPhase, TurnRecord};
use serde_json::Value;

pub(super) struct Material {
    documents: documents::DocumentProjection,
    pub effects: String,
    pub prior_tools: String,
    pub attachments: String,
    pub work_stream: String,
    pub images: Vec<Value>,
}

pub(super) async fn read(
    state: &GuidedTextState,
    turn: &TurnRecord,
) -> Result<Material, BtccError> {
    let documents = documents::read(
        &state.documents,
        turn,
        state.response_language.clone(),
        None,
    )
    .await?;
    let prior = state
        .journal
        .recent_for_prompt(turn.turn_id.clone())
        .await
        .map_err(BtccError::from)?;
    let prior_tools = super::prior_tool::render(prior)?;
    let effects = match state.work.context.as_ref() {
        Some(work) => state
            .effects
            .list_for_work(work.work.work_id.clone(), None)
            .await
            .map_err(butler_turn::btcc::BtccError::from)?,
        None => Vec::new(),
    };
    let effects = super::effect_context(&effects);
    let attachment_refs = super::attachments::source_refs(turn)?;
    let attachments = state
        .attachment_context
        .render(&attachment_refs, "User attachments")
        .await
        .map_err(|error| BtccError::relayed(error.code(), error.message()))?;
    let images = super::attachments::provider_images(turn);
    let work_stream = super::work_stream_context(state, &turn.session_id).await?;
    Ok(Material {
        documents,
        effects,
        prior_tools,
        attachments,
        work_stream,
        images,
    })
}

// Describe the selected bounded projection, never the discarded candidate.
type Render = ((String, Value), String, Value);

fn source(
    state: &GuidedTextState,
    turn: &TurnRecord,
    material: &Material,
    documents: &documents::DocumentProjection,
) -> Result<Render, BtccError> {
    Ok((
        super::source_prompt(turn, state, documents, material)?,
        super::skill_instructions(state, documents),
        documents.instruction_components.clone(),
    ))
}

pub(super) async fn render(
    state: &GuidedTextState,
    invocation: GuidedInvocation<'_>,
    material: &Material,
) -> Result<Render, BtccError> {
    let turn = invocation.turn;
    let exact = source(state, turn, material, &material.documents)?;
    let excluded = state.continuation_budget_enabled
        && match state.phase.phase {
            GuidedPhase::Direct => {
                super::nonempty_array(turn, "mandatoryHotCacheRefs")
                    || super::nonempty_array(turn, "optionalHotCacheRefs")
            }
            GuidedPhase::ReadOnly => super::nonempty_array(turn, "optionalHotCacheRefs"),
            GuidedPhase::Execution => false,
        };
    if !excluded {
        return Ok(exact);
    }
    let documents = phase_documents(state, turn).await?;
    let candidate = source(state, turn, material, &documents)?;
    if super::request_bytes(invocation, &candidate.0.0, &candidate.1, &state.butler_data)?
        < super::request_bytes(invocation, &exact.0.0, &exact.1, &state.butler_data)?
    {
        Ok(candidate)
    } else {
        Ok(exact)
    }
}

async fn phase_documents(
    state: &GuidedTextState,
    turn: &TurnRecord,
) -> Result<documents::DocumentProjection, BtccError> {
    let projected = phase_memory::read(&state.documents, turn, state.phase.phase.as_str()).await?;
    let empty = phase_memory::render(&projected, 0)?;
    let empty_documents = documents::read(
        &state.documents,
        turn,
        state.response_language.clone(),
        Some(&empty),
    )
    .await?;
    let fixed = super::memory_bytes(&empty_documents);
    if fixed > 12 * 1024 {
        return Err(too_large());
    }
    let selected = phase_memory::render(&projected, 12 * 1024 - fixed)?;
    let documents = documents::read(
        &state.documents,
        turn,
        state.response_language.clone(),
        Some(&selected),
    )
    .await?;
    if super::memory_bytes(&documents) > 12 * 1024 {
        return Err(too_large());
    }
    Ok(documents)
}

fn too_large() -> BtccError {
    BtccError::relayed(
        "phase_scoped_memory_projection_too_large",
        "phase_scoped_memory_projection_too_large",
    )
}
