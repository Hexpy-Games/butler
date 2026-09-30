//! A shutdown fence covers even a dispatch still preparing its Turn record.

use butler_turn::btcc::{Btcc, BtccError, StopRequest, TurnOutcome, TurnRequest};
use tokio_util::sync::CancellationToken;

pub(super) async fn run(
    btcc: &Btcc,
    request: TurnRequest,
    shutdown: &CancellationToken,
) -> Result<TurnOutcome, BtccError> {
    if shutdown.is_cancelled() {
        return Err(BtccError::relayed("turn_cancelled", "Service is stopping"));
    }
    let turn_id = request.turn_id.clone();
    let run = btcc.run_turn(request);
    tokio::pin!(run);
    tokio::select! {
        biased;
        result = &mut run => result,
        () = shutdown.cancelled() => {
            // BTCC installs its synchronous stop fence before storage awaits.
            // Keep the run future: cancellation must finish its publication.
            btcc.stop_turn(StopRequest { turn_id }).await?;
            run.await
        }
    }
}
