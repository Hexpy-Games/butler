//! The turn engine: one user message in, one durable assistant turn out.
//!
//! [`btcc`] owns the turn lifecycle (admission, the model/tool agent loop,
//! authority, effects, durable Work, progress and subsessions) and its SQLite
//! store. [`conversation`] is the canonical transcript store the turn reads and
//! writes, and [`workspace`] resolves session workspaces, worktrees and file
//! access. Everything outside a turn (providers, context assembly, memory, the
//! gateway) plugs in through the ports these modules declare.

// Production code reads slices, strings and JSON with checked accessors.
#![deny(clippy::indexing_slicing)]
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

pub mod btcc;
pub mod conversation;
#[cfg(test)]
mod test_clock;
pub mod workspace;
