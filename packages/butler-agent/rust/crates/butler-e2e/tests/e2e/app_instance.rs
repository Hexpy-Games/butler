//! One App per data folder: a later launch hands its arguments to the first and exits.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::time::Duration;

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::sandbox::Sandbox;
use butler_platform::app_instance::{Launch, claim};

/// APP-INSTANCE-01 — the first launch on a data folder owns it; a second launch on the same
/// folder reports that it handed over, and its arguments reach the first unchanged.
#[tokio::test]
async fn app_instance_01_second_launch_hands_over_its_arguments() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let sandbox = Sandbox::new("APP-INSTANCE-01")?;
    let data = sandbox.data.clone();
    let first = {
        let data = data.clone();
        tokio::task::spawn_blocking(move || claim(&data, &[]))
            .await
            .unwrap()?
    };
    let Launch::First(mut handed) = first else {
        panic!("the first launch did not own the folder");
    };
    let args = vec!["--butler-open-session=대화 1".to_owned()];
    let second = {
        let args = args.clone();
        tokio::task::spawn_blocking(move || claim(&data, &args))
            .await
            .unwrap()?
    };
    assert!(matches!(second, Launch::Forwarded));
    let received = tokio::time::timeout(Duration::from_secs(10), handed.recv())
        .await
        .expect("the first launch received nothing");
    assert_eq!(received, Some(args));
    Ok(())
}
