//! Re-select existing role/profile authorization only when the run's permission mode changes.
use super::GuidedTools;
use butler_turn::btcc::{
    AccessMode, BtccError, GuidedPhaseInput, ModelRoundTool, TurnRecord, select_phase,
};
use std::{collections::HashSet, sync::Arc};

pub(crate) struct Config {
    pub phase_surface_flag: String,
    pub operation_replay_flag: String,
    pub default_workspace: String,
    pub browsing_agent: bool,
}

pub(super) struct Snapshot {
    mode: AccessMode,
    authorized: HashSet<String>,
    visible: HashSet<String>,
    tools: Vec<ModelRoundTool>,
}

tokio::task_local! { static ADMISSION: Option<Arc<Snapshot>>; }

impl GuidedTools {
    pub(super) fn authorized(&self, name: &str) -> bool {
        super::permission_mode::approved_capability(name)
            || ADMISSION
                .try_with(|snapshot| snapshot.as_ref().map(|s| s.authorized.contains(name)))
                .ok()
                .flatten()
                .unwrap_or_else(|| self.binding.authorized_names.contains(name))
    }
    pub(super) fn visible(&self, name: &str) -> bool {
        ADMISSION
            .try_with(|snapshot| snapshot.as_ref().map(|s| s.visible.contains(name)))
            .ok()
            .flatten()
            .unwrap_or_else(|| self.binding.visible_names.contains(name))
    }
}

pub(super) async fn snapshot(
    owner: &GuidedTools,
    turn: &TurnRecord,
    mode: &AccessMode,
) -> Result<Option<Arc<Snapshot>>, BtccError> {
    if *mode == owner.binding.access_mode {
        return Ok(None);
    }
    if let Some(snapshot) = owner
        .permission_surface
        .lock()
        .as_ref()
        .filter(|s| s.mode == *mode)
    {
        return Ok(Some(snapshot.clone()));
    }
    let mut turn = turn.clone();
    butler_turn::btcc::project_turn_access_mode(&mut turn, mode);
    let config = &owner.binding.permission_config;
    let mut phase = select_phase(GuidedPhaseInput {
        turn: &turn,
        browsing_agent: config.browsing_agent,
        catalog: owner.catalog.snapshot(),
        phase_surface_flag: &config.phase_surface_flag,
        operation_replay_flag: &config.operation_replay_flag,
        default_workspace: &config.default_workspace,
    })
    .map_err(|e| BtccError::relayed("permission_surface_invalid", e.to_string()))?;
    let tools = super::super::factory::surface::for_owner(
        &mut phase,
        &owner.subsessions,
        &owner.monitoring,
        owner.catalog.snapshot(),
    )
    .await?;
    let snapshot = Arc::new(Snapshot {
        mode: mode.clone(),
        authorized: phase.authorized_names.into_iter().collect(),
        visible: tools.iter().map(|tool| tool.name.clone()).collect(),
        tools,
    });
    *owner.permission_surface.lock() = Some(snapshot.clone());
    Ok(Some(snapshot))
}

pub(super) async fn surface(
    owner: &GuidedTools,
    turn: &TurnRecord,
) -> Result<Vec<ModelRoundTool>, BtccError> {
    let mode = owner
        .authority
        .execution_access(owner.binding.turn_id.clone())
        .await?
        .unwrap_or_else(|| owner.binding.access_mode.clone());
    Ok(snapshot(owner, turn, &mode)
        .await?
        .map_or_else(|| owner.binding.surface.clone(), |s| s.tools.clone()))
}

pub(super) async fn scope<F: std::future::Future>(
    snapshot: Option<Arc<Snapshot>>,
    future: F,
) -> F::Output {
    ADMISSION.scope(snapshot, future).await
}
