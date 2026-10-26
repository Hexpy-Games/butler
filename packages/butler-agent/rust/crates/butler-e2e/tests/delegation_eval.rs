//! Owner-run delegation metrics; never selected by ordinary stub CI.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "evaluation assertions"
)]
#[path = "e2e/live/delegation_eval/checks.rs"]
mod checks;
#[path = "e2e/live/delegation_eval/contracts.rs"]
mod contracts;
#[path = "e2e/live/delegation_eval/db.rs"]
mod db;
#[path = "e2e/live/delegation_eval/fake.rs"]
mod fake;
#[path = "e2e/live/delegation_eval/first_shapes.rs"]
mod first_shapes;
#[path = "e2e/live/delegation_eval/fixture.rs"]
mod fixture;
#[path = "e2e/live/delegation_eval/local.rs"]
mod local;
#[path = "e2e/live/delegation_eval/run.rs"]
mod run;
use butler_e2e::e2e::{HarnessError, live};

#[tokio::test]
#[ignore = "on-demand live delegation evaluation"]
async fn delegation_live() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        std::env::var("BUTLER_E2E_DELEGATION_EVAL").as_deref() == Ok("1"),
        "requires BUTLER_E2E_DELEGATION_EVAL=1"
    );
    let Some(provider) = live::gate("DELEGATION-EVAL")? else {
        return Ok(());
    };
    run::suite(Some(provider)).await
}

#[tokio::test]
#[ignore = "on-demand offline pipeline self-test"]
async fn delegation_offline() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        std::env::var("BUTLER_E2E_DELEGATION_EVAL").as_deref() == Ok("1"),
        "requires BUTLER_E2E_DELEGATION_EVAL=1"
    );
    assert_eq!(std::env::var("BUTLER_E2E_TIER").as_deref(), Ok("stub"));
    run::suite(None).await
}

#[tokio::test]
#[ignore = "on-demand offline wire and routing self-test"]
async fn delegation_contracts() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    assert_eq!(std::env::var("BUTLER_E2E_TIER").as_deref(), Ok("stub"));
    contracts::anthropic_default();
    contracts::responses_output_items();
    contracts::anthropic_blocks();
    first_shapes::verify().await?;
    contracts::forwarding().await?;
    contracts::round_limit().await
}
