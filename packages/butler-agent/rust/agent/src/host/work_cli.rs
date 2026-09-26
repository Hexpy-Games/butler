//! One-shot native reader for legacy TaskStore Work commands.

mod commands;
mod options;
mod output;
#[cfg(test)]
mod tests;

use std::ffi::OsString;

use super::ResolvedInstallation;
use crate::locale::LocaleCollation;
use commands::execute;
use options::{parse, resolve_data_root};
use output::{render_error, render_success};

pub use output::NativeWorkCliResult;

pub fn recognizes(args: &[OsString]) -> bool {
    options::recognizes(args)
}

pub async fn run(
    installation: ResolvedInstallation,
    raw_args: Vec<OsString>,
) -> NativeWorkCliResult {
    let json_requested = raw_args.iter().any(|arg| arg == "--json");
    let options = match parse(raw_args) {
        Ok(options) => options,
        Err(error) => return render_error(json_requested, "butler work", &error),
    };
    let command = options.command_name();
    let json_output = options.json;
    let quiet = options.quiet;
    let data_root = match resolve_data_root(&installation, options.data.as_deref()) {
        Ok(path) => path,
        Err(error) => return render_error(json_output, &command, &error),
    };
    let collation = match LocaleCollation::new("en-US") {
        Ok(value) => value,
        Err(_) => {
            return render_error(
                json_output,
                &command,
                &output::failure(
                    "work_records_unavailable",
                    "Work records are unavailable.",
                    1,
                ),
            );
        }
    };
    let outcome =
        tokio::task::spawn_blocking(move || execute(&data_root, &options, &collation)).await;
    match outcome {
        Ok(Ok((command, data, human))) => {
            render_success(json_output, &command, data, &human, quiet)
        }
        Ok(Err(error)) => render_error(json_output, &command, &error),
        Err(_) => render_error(
            json_output,
            &command,
            &output::failure(
                "work_records_unavailable",
                "Work records are unavailable.",
                1,
            ),
        ),
    }
}
