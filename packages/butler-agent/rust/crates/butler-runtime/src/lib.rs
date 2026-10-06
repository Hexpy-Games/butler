//! Everything a turn calls out to while it runs.
//!
//! [`context`] assembles and compacts the model context, reads tool output
//! and documents; [`operations`] executes model rounds and records usage
//! metrics; [`capabilities`] implements the built-in file tools and the tool
//! catalog; [`skills`] manages installed skills; [`web_access`] fetches and
//! searches the public web. Each plugs into a BTCC port.

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

pub mod browser;
pub mod capabilities;
pub mod context;
pub mod operations;
pub mod outputs;
pub mod skills;
pub mod web_access;
