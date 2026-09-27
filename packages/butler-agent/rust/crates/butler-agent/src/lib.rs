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
mod web_access;
mod work_records;
mod workspace;

#[cfg(unix)]
pub use host::cli::command::{Command, main};
