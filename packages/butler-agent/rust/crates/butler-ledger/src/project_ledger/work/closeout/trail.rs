//! The checkpoint children a review or disposition adds, numbered after the
//! manifest's current checkpoint revision.

use serde_json::Value;

use butler_turn::btcc::{
    ActionProgress, BtccError, Checkpoint, DispositionCommand, ProjectWorkOperationIdentity,
    ReviewCommand, WorkStage,
};

use super::super::codec::{self, Snapshot};
use super::super::invalid;
use super::super::progress::{CheckpointChildInput, checkpoint_child};

/// The checkpoints one operation adds before publishing, numbered after the
/// manifest's current checkpoint revision.
pub(super) struct Trail<'a> {
    current: &'a Snapshot,
    identity: &'a ProjectWorkOperationIdentity,
    at: &'a str,
    revision: u64,
    pub(super) children: Vec<Value>,
    pub(super) latest: Option<Checkpoint>,
}

impl<'a> Trail<'a> {
    pub(super) fn new(
        current: &'a Snapshot,
        identity: &'a ProjectWorkOperationIdentity,
        at: &'a str,
    ) -> Result<Self, BtccError> {
        Ok(Self {
            current,
            identity,
            at,
            revision: codec::number(&current.manifest, "checkpointRevision")?,
            children: Vec::new(),
            latest: None,
        })
    }

    fn push(&mut self, input: CheckpointChildInput<'_>) -> Result<(), BtccError> {
        let child = checkpoint_child(input);
        self.latest =
            Some(codec::typed(child.get("checkpoint").cloned().ok_or_else(
                || invalid("project_work_managed_record_invalid"),
            )?)?);
        self.children.push(child);
        Ok(())
    }

    /// A checkpoint at `stage` entering or leaving the reviewed stage.
    pub(super) fn review_checkpoint(
        &mut self,
        command: &ReviewCommand,
        stage: WorkStage,
        edge: &str,
    ) -> Result<(), BtccError> {
        self.revision += 1;
        let next = command
            .input
            .corrections
            .first()
            .map(String::as_str)
            .unwrap_or("");
        let checkpoint_identity = format!(
            "{}\0{}-{edge}",
            command.input.mutation_call_id,
            stage_name(command.entry_stage)
        );
        self.push(CheckpointChildInput {
            current: self.current,
            turn_id: &command.input.scope.turn_id,
            identity: self.identity,
            at: self.at,
            revision: self.revision,
            stage,
            plan_id: &command.expected_plan_revision_id,
            progress: &command.action_progress,
            summary: &command.input.summary,
            next,
            checkpoint_identity: &checkpoint_identity,
        })
    }

    /// The checkpoint closing the current plan with the disposed progress.
    pub(super) fn disposition_checkpoint(
        &mut self,
        command: &DispositionCommand,
        plan_id: &str,
        progress: &[ActionProgress],
    ) -> Result<(), BtccError> {
        self.revision += 1;
        let next = command
            .remaining_actions
            .first()
            .map(String::as_str)
            .or(command.input.next_condition.as_deref())
            .unwrap_or("");
        let checkpoint_identity = format!("{}\0disposition", command.input.mutation_call_id);
        self.push(CheckpointChildInput {
            current: self.current,
            turn_id: &command.input.scope.turn_id,
            identity: self.identity,
            at: self.at,
            revision: self.revision,
            stage: self
                .current
                .view
                .current_stage
                .unwrap_or(WorkStage::Planning),
            plan_id,
            progress,
            summary: &command.normalized_summary,
            next,
            checkpoint_identity: &checkpoint_identity,
        })
    }

    /// The manifest revisions after these checkpoints.
    pub(super) fn revisions(&self) -> codec::Revisions {
        let mut revisions = codec::revisions(&self.current.manifest);
        revisions.checkpoint_revision = self.revision;
        if self.latest.is_some() {
            revisions.checkpoint_result_sequence = self.current.view.result_refs.len() as u64;
        }
        revisions
    }
}

fn stage_name(stage: butler_turn::btcc::WorkStage) -> &'static str {
    match stage {
        butler_turn::btcc::WorkStage::Conception => "conception",
        butler_turn::btcc::WorkStage::Planning => "planning",
        butler_turn::btcc::WorkStage::Execution => "execution",
        butler_turn::btcc::WorkStage::Review => "review",
        butler_turn::btcc::WorkStage::Validation => "validation",
        butler_turn::btcc::WorkStage::Reporting => "reporting",
    }
}
