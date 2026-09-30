//! A shutdown fence covers even a dispatch still preparing its Turn record.

use butler_turn::btcc::{Btcc, BtccError, TurnOutcome, TurnRequest};
use tokio_util::sync::CancellationToken;

pub(super) const INTERRUPTED: &str = "turn_shutdown_interrupted";

pub(super) async fn run(
    btcc: &Btcc,
    request: TurnRequest,
    shutdown: &CancellationToken,
) -> Result<TurnOutcome, BtccError> {
    if shutdown.is_cancelled() {
        return Err(interrupted());
    }
    let turn_id = request.turn_id.clone();
    let run = btcc.run_turn(request);
    tokio::pin!(run);
    tokio::select! {
        biased;
        result = &mut run => result,
        () = shutdown.cancelled() => {
            // Stop execution first, retaining durable state and publication.
            // A user cancel alone owns cancellation and the queue pause.
            btcc.interrupt_turn(&turn_id);
            run.await.map_err(|_| interrupted())
        }
    }
}

fn interrupted() -> BtccError {
    BtccError::relayed(INTERRUPTED, "Service stopped before the turn finished")
}
