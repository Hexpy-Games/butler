use super::super::contracts::{
    ActionProgress, DispositionCommand, OriginalRequest, WorkResultFact, WorkView,
};
use super::ProjectWorkToolResultEvidence;
use super::identity::{
    ProjectWorkBinding, ProjectWorkCanonicalLocation, ProjectWorkOperationIdentity,
    ResolvedProjectWorkScope,
};
use super::legacy::{
    LegacyProjectWorkSourceSnapshot, ProjectWorkLegacyInput, ProjectWorkLegacyObservation,
    ProjectWorkLegacyObserveInput, ProjectWorkLegacySnapshot,
};
use super::material::{ProjectWorkCapturedMaterial, ProjectWorkMaterialInput};
use crate::btcc::{PortFuture, WorkTurnScope};

/// Locates a project's canonical Works for a session or turn.
#[derive(Clone, Debug)]
pub struct ProjectWorkLocateInput {
    pub scope: ResolvedProjectWorkScope,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
}

/// One observed project Work with its turn bindings.
#[derive(Clone, Debug)]
pub struct ProjectWorkObserveWork {
    pub work: WorkView,
    pub bindings: Vec<ProjectWorkBinding>,
}

/// The project Works to persist for a canonical ledger head.
#[derive(Clone, Debug)]
pub struct ProjectWorkObserveWorks {
    pub works: Vec<ProjectWorkObserveWork>,
    pub session_head_work_id: String,
    pub ledger_project_id: String,
    pub canonical_head_sha256: String,
    pub legacy_import_claim_work_id: Option<String>,
}

/// What a project disposition applies to the current Work view.
#[derive(Clone, Debug)]
pub enum ProjectWorkDispositionPreparation {
    CurrentView,
    Apply {
        action_progress: Vec<ActionProgress>,
        evidence_snapshot: Vec<String>,
    },
}

/// Projects project-ledger Work into the runtime's Work store.
pub trait ProjectWorkRuntimeProjection: Send + Sync {
    /// The canonical Works of the project scope.
    fn locate_canonical_works(
        &self,
        input: ProjectWorkLocateInput,
    ) -> PortFuture<'_, ProjectWorkCanonicalLocation>;
    /// The original request of the turn's Work.
    fn load_original_request(&self, scope: WorkTurnScope) -> PortFuture<'_, OriginalRequest>;
    /// The attached result facts of a Work.
    fn load_result_facts(&self, work_id: String) -> PortFuture<'_, Vec<WorkResultFact>>;
    /// When a project operation was recorded.
    fn operation_recorded_at(
        &self,
        identity: ProjectWorkOperationIdentity,
    ) -> PortFuture<'_, String>;
    /// What a disposition command applies to the current Work.
    fn prepare_disposition(
        &self,
        command: DispositionCommand,
        current: WorkView,
    ) -> PortFuture<'_, ProjectWorkDispositionPreparation>;
    /// The Work's material snapshot and fingerprint.
    fn capture_work_material(
        &self,
        input: ProjectWorkMaterialInput,
    ) -> PortFuture<'_, ProjectWorkCapturedMaterial>;
    /// Persists observed canonical Works.
    fn observe_canonical_works(&self, input: ProjectWorkObserveWorks) -> PortFuture<'_, ()>;
}

/// Identifies a committed tool result of a turn.
#[derive(Clone, Debug)]
pub struct ProjectWorkCommittedResultInput {
    pub turn_id: String,
    pub session_id: String,
    pub tool_call_id: String,
}

/// Reads committed tool results as Work evidence.
pub trait ProjectWorkResultRuntime: Send + Sync {
    /// The committed result's digest-verified evidence.
    fn read_committed_result(
        &self,
        input: ProjectWorkCommittedResultInput,
    ) -> PortFuture<'_, ProjectWorkToolResultEvidence>;
}

/// Reads open legacy (R2) project Work.
pub trait LegacyProjectWorkSource: Send + Sync {
    /// The open legacy Work of the given programs, if any.
    fn load_open_work(
        &self,
        project_ref: String,
        program_ids: Vec<String>,
    ) -> PortFuture<'_, Option<LegacyProjectWorkSourceSnapshot>>;
}

/// Imports legacy project Work into the runtime's Work store.
pub trait ProjectWorkLegacyRuntime: Send + Sync {
    /// A pending import observation, if any.
    fn read_import_observation(
        &self,
        input: ProjectWorkLegacyInput,
    ) -> PortFuture<'_, Option<ProjectWorkLegacyObservation>>;
    /// A stable snapshot of the legacy Work to import, if any.
    fn capture_stable_snapshot(
        &self,
        input: ProjectWorkLegacyInput,
    ) -> PortFuture<'_, Option<Arc<ProjectWorkLegacySnapshot>>>;
    /// Checks the snapshot still matches its source before it is observed.
    fn revalidate_before_observation(
        &self,
        input: ProjectWorkLegacyInput,
        snapshot: Arc<ProjectWorkLegacySnapshot>,
    ) -> PortFuture<'_, ()>;
    /// Records the imported Work and replaces its native history.
    fn observe_imported(&self, input: ProjectWorkLegacyObserveInput) -> PortFuture<'_, ()>;
}
use std::sync::Arc;
