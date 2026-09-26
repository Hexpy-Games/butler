use super::super::contracts::{
    ActionProgress, DispositionCommand, OriginalRequest, WorkResultFact, WorkView,
};
use super::identity::{
    ProjectWorkBinding, ProjectWorkCanonicalLocation, ProjectWorkOperationIdentity,
    ResolvedProjectWorkScope,
};
use super::legacy::{
    LegacyProjectWorkSourceSnapshot, ProjectWorkLegacyInput, ProjectWorkLegacyObservation,
    ProjectWorkLegacyObserveInput, ProjectWorkLegacySnapshot,
};
use super::material::{ProjectWorkCapturedMaterial, ProjectWorkMaterialInput};
use super::result::ProjectWorkToolResultEvidence;
use crate::btcc::{PortFuture, WorkTurnScope};

#[derive(Clone, Debug)]
pub(crate) struct ProjectWorkLocateInput {
    pub scope: ResolvedProjectWorkScope,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct ProjectWorkObserveWork {
    pub work: WorkView,
    pub bindings: Vec<ProjectWorkBinding>,
}

#[derive(Clone, Debug)]
pub(crate) struct ProjectWorkObserveWorks {
    pub works: Vec<ProjectWorkObserveWork>,
    pub session_head_work_id: String,
    pub ledger_project_id: String,
    pub canonical_head_sha256: String,
    pub legacy_import_claim_work_id: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) enum ProjectWorkDispositionPreparation {
    CurrentView,
    Apply {
        action_progress: Vec<ActionProgress>,
        evidence_snapshot: Vec<String>,
    },
}

pub(crate) trait ProjectWorkRuntimeProjection: Send + Sync {
    fn locate_canonical_works(
        &self,
        input: ProjectWorkLocateInput,
    ) -> PortFuture<'_, ProjectWorkCanonicalLocation>;
    fn load_original_request(&self, scope: WorkTurnScope) -> PortFuture<'_, OriginalRequest>;
    fn load_result_facts(&self, work_id: String) -> PortFuture<'_, Vec<WorkResultFact>>;
    fn operation_recorded_at(
        &self,
        identity: ProjectWorkOperationIdentity,
    ) -> PortFuture<'_, String>;
    fn prepare_disposition(
        &self,
        command: DispositionCommand,
        current: WorkView,
    ) -> PortFuture<'_, ProjectWorkDispositionPreparation>;
    fn capture_work_material(
        &self,
        input: ProjectWorkMaterialInput,
    ) -> PortFuture<'_, ProjectWorkCapturedMaterial>;
    fn observe_canonical_works(&self, input: ProjectWorkObserveWorks) -> PortFuture<'_, ()>;
}

#[derive(Clone, Debug)]
pub(crate) struct ProjectWorkCommittedResultInput {
    pub turn_id: String,
    pub session_id: String,
    pub tool_call_id: String,
}

pub(crate) trait ProjectWorkResultRuntime: Send + Sync {
    fn read_committed_result(
        &self,
        input: ProjectWorkCommittedResultInput,
    ) -> PortFuture<'_, ProjectWorkToolResultEvidence>;
}

pub(crate) trait LegacyProjectWorkSource: Send + Sync {
    fn load_open_work(
        &self,
        project_ref: String,
        program_ids: Vec<String>,
    ) -> PortFuture<'_, Option<LegacyProjectWorkSourceSnapshot>>;
}

pub(crate) trait ProjectWorkLegacyRuntime: Send + Sync {
    fn read_import_observation(
        &self,
        input: ProjectWorkLegacyInput,
    ) -> PortFuture<'_, Option<ProjectWorkLegacyObservation>>;
    fn capture_stable_snapshot(
        &self,
        input: ProjectWorkLegacyInput,
    ) -> PortFuture<'_, Option<Arc<ProjectWorkLegacySnapshot>>>;
    fn revalidate_before_observation(
        &self,
        input: ProjectWorkLegacyInput,
        snapshot: Arc<ProjectWorkLegacySnapshot>,
    ) -> PortFuture<'_, ()>;
    fn observe_imported(&self, input: ProjectWorkLegacyObserveInput) -> PortFuture<'_, ()>;
}
use std::sync::Arc;
