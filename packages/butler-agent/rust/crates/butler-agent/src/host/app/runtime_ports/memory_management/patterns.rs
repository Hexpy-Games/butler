//! Adapter over the consolidation-owned pattern repository.
use super::*;
use butler_memory::cognition::PatternError;
impl AppMemoryManagement {
    pub(super) async fn pattern_command(
        &self,
        command: AppMemoryCommand,
        sink: MemoryEventSink,
        cancellation: CancellationToken,
    ) -> Result<Value, GatewayApplicationError> {
        let repository = self.daily.patterns();
        let now = chrono::DateTime::parse_from_rfc3339(&self.clock.now_iso())
            .map_err(GatewayApplicationError::internal_from)?
            .with_timezone(&chrono::Utc);
        match command {
            AppMemoryCommand::Patterns => repository.view().await.map_err(pattern_error),
            AppMemoryCommand::PatternProposals => {
                repository.proposals().await.map_err(pattern_error)
            }
            AppMemoryCommand::DeletePattern {
                id,
                expected_revision,
            } => {
                repository
                    .delete(id, expected_revision, now, &cancellation)
                    .await
                    .map_err(pattern_error)?;
                sink(json!({"kind":"patterns","phase":"complete"})).await?;
                Ok(json!({"revision":expected_revision + 1}))
            }
            AppMemoryCommand::DecidePattern {
                bundle_id,
                pattern_id,
                decision,
                expected_revision,
            } => {
                repository
                    .decide(
                        bundle_id,
                        pattern_id,
                        decision,
                        expected_revision,
                        now,
                        &cancellation,
                    )
                    .await
                    .map_err(pattern_error)?;
                sink(json!({"kind":"patterns","phase":"complete"})).await?;
                Ok(json!({"revision":expected_revision + 1}))
            }
            _ => Err(GatewayApplicationError::internal()),
        }
    }
}
fn pattern_error(source: PatternError) -> GatewayApplicationError {
    let status = match source {
        PatternError::NotFound => 404,
        PatternError::Conflict | PatternError::Busy => 409,
        PatternError::InvalidDecision => 400,
        _ => 500,
    };
    public_error(status, source.code(), "Pattern operation unavailable.").with_source(source)
}
