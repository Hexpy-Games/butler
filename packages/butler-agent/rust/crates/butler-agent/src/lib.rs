#[macro_use]
extern crate butler_core;

mod capabilities;
mod cognition;
mod context;
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
mod web_access;
mod work_records;

#[cfg(unix)]
pub use host::cli::command::{Command, main};
