//! The locked stages of a conversation source registration: schema, replay and register, each under its own consolidation lease.

use super::*;

/// What each locked stage of a registration runs with.
pub(super) struct Stages {
    pub(super) environment: CognitionPathEnvironment,
    pub(super) coordinator: Arc<CognitionWriteCoordinator>,
    pub(super) clock: Clock,
    pub(super) shutdown: CancellationToken,
}

impl Stages {
    /// Takes the consolidation lease and runs `stage` with it on the
    /// blocking pool; the state is closed when the lease cannot be taken.
    async fn locked<T: Send + 'static>(
        &self,
        state: Box<OperationState>,
        stage: impl FnOnce(
            Box<OperationState>,
            CognitionWriteLease,
            PathBuf,
            CognitionPathEnvironment,
        ) -> CognitionResult<T>
        + Send
        + 'static,
    ) -> CognitionResult<T> {
        let lock_path = self.environment.consolidation_lock(&state.input.data_root);
        let lease = match acquire(
            &self.coordinator,
            lock_path.clone(),
            &state.input,
            &self.shutdown,
        )
        .await
        {
            Ok(lease) => lease,
            Err(error) => return close_after_failure(state, error).await,
        };
        let environment = self.environment.clone();
        tokio::task::spawn_blocking(move || stage(state, lease, lock_path, environment))
            .await
            .map_err(join_error)?
    }

    pub(super) async fn ensure_schema(
        &self,
        state: Box<OperationState>,
    ) -> CognitionResult<Box<OperationState>> {
        let clock = self.clock.clone();
        self.locked(state, move |mut state, lease, lock_path, environment| {
            let result = mutate(&mut state, lease, &lock_path, &environment, |state| {
                state.graph.ensure_schema(&clock())
            });
            match result {
                Ok(()) => Ok(state),
                Err(error) => Err(close_with_error(state, error)),
            }
        })
        .await
    }

    /// Replays an earlier registration of the same source revision; its
    /// progress when there was one.
    pub(super) async fn replay(&self, state: Box<OperationState>) -> CognitionResult<ReplayStage> {
        let clock = self.clock.clone();
        self.locked(state, move |mut state, lease, lock_path, environment| {
            let replay = match mutate(&mut state, lease, &lock_path, &environment, |state| {
                let now = clock();
                state.graph.replay(
                    &state.canonical,
                    state.input.notice.borrowed(),
                    &state.plan.episode_id,
                    &state.plan.revision,
                    state.input.completion_job_id.as_deref(),
                    &now,
                )
            }) {
                Ok(replay) => replay,
                Err(error) => return Err(close_with_error(state, error)),
            };
            let Some(job_id) = replay else {
                return Ok(ReplayStage::Continue(state));
            };
            let progress = match state.graph.progress(&job_id) {
                Ok(progress) => progress,
                Err(error) => return Err(close_with_error(state, error)),
            };
            close_state(state)?;
            Ok(ReplayStage::Complete(Box::new(progress)))
        })
        .await
    }

    pub(super) async fn register(
        &self,
        state: Box<OperationState>,
    ) -> CognitionResult<ConversationRegistrationOutcome> {
        let clock = self.clock.clone();
        self.locked(state, move |mut state, lease, lock_path, environment| {
            let result = (|| {
                let registration = mutate(&mut state, lease, &lock_path, &environment, |state| {
                    state.graph.register(RegistrationInput {
                        generation_id: &state.handle.generation_id,
                        plan: &state.plan,
                        notice: state.input.notice.borrowed(),
                        canonical: &state.canonical,
                        completion_id: state.input.completion_job_id.as_deref(),
                        extraction_model: &state.extraction_model,
                        reasoning_effort: &state.reasoning_effort,
                        clock: clock.as_ref(),
                    })
                })?;
                let progress = state.graph.progress(&registration.job_id)?;
                Ok(ConversationRegistrationOutcome::Registered(progress))
            })();
            match result {
                Ok(outcome) => close_state(state).map(|()| outcome),
                Err(error) => Err(close_with_error(state, error)),
            }
        })
        .await
    }
}
