//! The Project Ledger: committed project records and project Work.
//!
//! [`project_ledger`] reads and publishes the canonical project record files,
//! implements BTCC's Project Work port (plans, reviews and completion of
//! project-scoped Work) over its SQLite index, and builds the project
//! dashboard and briefing signals.

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
// Every public item is documented, every slice/array/Value access is
// checked, every fallible signature can fail, and blocks nest at most four
// deep (the crate's clippy.toml sets the threshold).
#![deny(
    missing_docs,
    clippy::indexing_slicing,
    clippy::unnecessary_wraps,
    clippy::excessive_nesting
)]

pub mod project_ledger;
