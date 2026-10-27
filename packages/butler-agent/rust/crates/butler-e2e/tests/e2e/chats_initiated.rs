//! SS2 and the shared ordering/quiet-hours gate through public routes.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Scenario, Setup, accepted_turn_id},
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
pub(super) mod support;
use support::*;

mod requires_e2e_fixtures;
