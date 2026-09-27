// Fixtures are compiled for tests and, through the `test-support` feature,
// for dependent crates' tests; like tests they may abort on setup failure.
// Libraries are also linted as non-test builds without features.
#![cfg_attr(
    any(test, feature = "test-support"),
    allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]
// The feature compiles the fixtures without the tests that use most of them.
#![cfg_attr(
    all(feature = "test-support", not(test)),
    allow(dead_code, unused_imports)
)]

#[macro_use]
extern crate butler_core;

pub(crate) mod btcc;
mod capabilities;
mod cognition;
mod context;
mod conversation;
mod coordination;
pub(crate) mod gateway;

mod mcp_client;
mod models;
mod operations;
mod profile;
mod project_ledger;
mod skills;

mod host;
#[cfg(test)]
mod scenarios;
#[cfg(test)]
mod test_clock;
mod web_access;
mod work_records;
mod workspace;

#[cfg(unix)]
pub use host::cli::command::{Command, main};
