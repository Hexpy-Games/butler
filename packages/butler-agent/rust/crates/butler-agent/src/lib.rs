#[macro_use]
extern crate butler_core;

mod cognition;
mod coordination;
pub(crate) mod gateway;

mod profile;

mod host;
#[cfg(test)]
mod scenarios;
mod work_records;

#[cfg(unix)]
pub use host::cli::command::{Command, main};
