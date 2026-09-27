mod host;
#[cfg(test)]
mod scenarios;

#[cfg(unix)]
pub use host::cli::command::{Command, main};
