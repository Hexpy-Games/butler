//! Generation build cursors and the typed source registration adapter.

use super::{
    CatchupState, CognitionResult, GraphRegistration, GraphRepository, TypedRegistrationInput,
    jobs, typed_registration,
};

impl GraphRepository {
    pub(in crate::cognition) fn catchup_state(&self) -> CognitionResult<CatchupState> {
        jobs::catchup_state(self.connection()?)
    }

    pub(in crate::cognition) fn save_catchup_state(
        &mut self,
        state: &CatchupState,
    ) -> CognitionResult<()> {
        jobs::save_catchup_state(self.connection_mut()?, state)
    }

    pub(in crate::cognition) fn has_recoverable_windows(&self) -> CognitionResult<bool> {
        super::probe::has_recoverable_windows(self.connection()?)
    }

    pub(in crate::cognition) fn has_vector_work(&self, now: &str) -> CognitionResult<bool> {
        super::probe::has_vector_work(self.connection()?, now)
    }

    pub(in crate::cognition) fn registered_observations(
        &self,
        ids: &[String],
    ) -> CognitionResult<std::collections::HashSet<String>> {
        jobs::registered_observations(self.connection()?, ids)
    }

    pub(in crate::cognition) fn register_typed(
        &mut self,
        input: TypedRegistrationInput<'_>,
    ) -> CognitionResult<GraphRegistration> {
        typed_registration::register_typed(self.connection_mut()?, input)
    }
}
