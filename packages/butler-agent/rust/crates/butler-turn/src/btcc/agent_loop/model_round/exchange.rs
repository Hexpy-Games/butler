//! Complete the provider stream before acceptance and loop settlement work.
use super::{AttemptError, ModelRoundRequest, ModelRoundResult, Round};

pub(super) async fn run(
    round: &Round<'_, '_>,
    request: ModelRoundRequest<'_>,
) -> Result<ModelRoundResult, AttemptError> {
    let input = round.input;
    let timing = super::super::command_timing::CommandTiming::new("model_exchange");
    input.model_round_observer.request(&request).await;
    timing.mark("before_round");
    let response = input.model.run_round(request).await;
    if let Some(observer) = round.prepared.ports.stream_observer.as_deref() {
        observer.round_finished();
    }
    let response = response.map_err(AttemptError::Model)?;
    timing.mark("round_returned");
    input.model_round_observer.response(&response).await;
    timing.mark("observer_returned");
    Ok(response)
}
