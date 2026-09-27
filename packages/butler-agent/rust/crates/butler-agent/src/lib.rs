mod host;

#[cfg(unix)]
pub use host::cli::command::{Command, main};
