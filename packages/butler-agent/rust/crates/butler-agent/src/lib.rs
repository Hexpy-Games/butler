//! The `butler-agent` host: process composition, CLI, service and App server.
//!
//! This crate owns no domain logic. It builds the domain services from the
//! crates below and exposes them through the command line ([`Command`]) and the
//! App gateway:
//!
//! - `butler-core`: codecs, locale, text and the tool protocol (leaf).
//! - `butler-turn`: the turn engine (BTCC), transcript store and workspaces.
//! - `butler-models`: model providers and MCP clients.
//! - `butler-runtime`: context, operations, built-in tools, skills, web access.
//! - `butler-ledger`: the Project Ledger.
//! - `butler-memory`: cognition, profile, work records, write coordination.
//! - `butler-gateway`: the App HTTP and WebSocket API.
//!
//! Start reading at [`main`] and `host::runtime`, which composes every service.

mod host;

#[cfg(unix)]
pub use host::cli::command::{Command, main};
