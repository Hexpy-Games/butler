//! Model providers and MCP clients: everything that talks to an LLM endpoint.
//!
//! [`models`] owns the model catalog, provider configuration and credentials,
//! the provider HTTP clients and prompt-usage accounting, and implements the
//! BTCC model-round port. [`mcp_client`] manages the MCP server registry and
//! client sessions that expose external tools.

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

pub mod mcp_client;
pub mod models;
