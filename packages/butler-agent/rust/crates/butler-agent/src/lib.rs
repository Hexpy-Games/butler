#[macro_use]
extern crate butler_core;

pub(crate) mod gateway;

mod host;
#[cfg(test)]
mod scenarios;

#[cfg(unix)]
pub use host::cli::command::{Command, main};
