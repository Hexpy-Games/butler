//! Write refusal and command reporting through the real gateway and stub provider.
use super::*;
#[tokio::test]
async fn tsk_05_file_write_refused_and_command_write_reported_to_worker_and_steward() -> Result {
    butler_e2e::gate!();
    Ok(crate::delegation_handoff::scope_writes().await?)
}
