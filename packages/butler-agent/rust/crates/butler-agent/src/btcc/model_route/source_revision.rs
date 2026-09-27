use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use crate::btcc::TurnRecord;

/// One Turn's activity and model-route projections share this sequence.
/// It retains no Turn, provider, store, or callback.
#[derive(Clone)]
pub(crate) struct GuidedSourceRevision(Arc<AtomicU64>);

impl GuidedSourceRevision {
    pub(crate) fn from_turn(turn: &TurnRecord) -> Self {
        let restored = turn
            .authority_continuation
            .as_ref()
            .and_then(|value| value.get("presentation"))
            .and_then(|value| value.get("sourceRevision"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        Self(Arc::new(AtomicU64::new(restored)))
    }

    pub(crate) fn next(&self) -> u64 {
        self.0.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub(crate) fn current(&self) -> u64 {
        self.0.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::btcc::model_route::test_support::*;
    use crate::btcc::model_route::{
        ModelExecutionFactory, ModelExecutionInput, ModelRouteRetryConfig,
        TurnModelExecutionFactory,
    };
    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    #[tokio::test]
    async fn route_and_activity_share_one_restored_source_revision_counter() {
        let mut turn = turn(route(0, 1));
        turn.authority_continuation = Some(json!({"presentation":{"sourceRevision":7}}));
        let revisions = GuidedSourceRevision::from_turn(&turn);
        let other_turn = GuidedSourceRevision::from_turn(&turn);
        let store = Arc::new(Store::default());
        let base = Base::new([
            Err(provider("provider_model_not_found", None)),
            Ok(result("fallback")),
        ]);
        let claim = claim();
        let progress = Progress::default();
        let execution = TurnModelExecutionFactory::new(store, ModelRouteRetryConfig::new(0.0))
            .create(ModelExecutionInput {
                turn: &turn,
                claim: &claim,
                progress: &progress,
                model_round_observer: &crate::btcc::NOOP_MODEL_ROUND_OBSERVER,
                cancellation: CancellationToken::new(),
                base: &base,
                source_revision: revisions.clone(),
            })
            .await
            .unwrap();
        assert_eq!(revisions.next(), 8);
        run(execution.as_ref(), "shared-revision").await.unwrap();
        assert_eq!(
            progress.events.lock().unwrap()[0].payload.as_ref().unwrap()["sourceRevision"],
            9
        );
        assert_eq!(revisions.next(), 10);
        assert_eq!(other_turn.next(), 8);
    }
}
