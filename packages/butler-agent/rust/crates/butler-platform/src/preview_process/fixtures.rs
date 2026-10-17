//! Fault injection compiled only into test-support agents.
use std::{io, time::Duration};

pub(super) async fn completion() -> io::Result<()> {
    match std::env::var("BUTLER_TEST_PREVIEW_COMPLETION").as_deref() {
        Ok("error") => Err(io::Error::other("Injected preview completion failure")),
        Ok("timeout") => {
            tokio::time::sleep(super::STOP_WAIT_LIMIT + Duration::from_secs(1)).await;
            Ok(())
        }
        _ => Ok(()),
    }
}
