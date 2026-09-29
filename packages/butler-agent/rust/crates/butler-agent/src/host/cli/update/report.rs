//! Output of the Agent package commands: one JSON envelope, or one terse
//! human line, shared by `install`, `update`, `rollback`, `versions` and
//! `uninstall`.

use std::process::ExitCode;

use serde_json::{Value, json};

use crate::host::cli::error::CliError;

/// How a command was asked to print.
#[derive(Clone, Copy)]
pub(super) struct Output {
    /// The command name in the JSON envelope, e.g. `butler install`.
    pub(super) command: &'static str,
    pub(super) json: bool,
    pub(super) quiet: bool,
}

impl Output {
    /// Prints the result and returns success.
    pub(super) fn ok(self, data: &Value, human: &str) -> ExitCode {
        if self.json {
            println!(
                "{}",
                json!({
                    "ok": true,
                    "command": self.command,
                    "data": data,
                    "error": null,
                    "privacy": {"rawTextIncluded": false, "secretsIncluded": false}
                })
            );
        } else if !self.quiet && !human.is_empty() {
            println!("{human}");
        }
        ExitCode::SUCCESS
    }

    /// Prints the failure and returns its exit code.
    pub(super) fn fail(self, error: &CliError) -> ExitCode {
        if self.json {
            println!(
                "{}",
                json!({
                    "ok": false,
                    "command": self.command,
                    "data": null,
                    "error": {"code": error.code, "message": error.message},
                })
            );
        } else {
            eprintln!("{}: {}", error.code, error.message);
        }
        ExitCode::from(error.exit)
    }
}

/// A failure of the runtime's install operations, as a CLI error: its wire
/// code and a sentence saying what to do.
pub(super) fn install_error(error: &butler_runtime::operations::UpdateError) -> CliError {
    let code = error.code();
    CliError::failed(code, install_message(code))
}

fn install_message(code: &str) -> &'static str {
    match code {
        "install_archive_format_unsupported" => "the archive is not a gzip-compressed tar",
        "install_archive_too_large" => "the archive is larger than an Agent archive can be",
        "install_archive_unsafe" => "the archive has an entry that could write outside the install",
        "install_busy" => "another install, update or rollback is running; try again",
        "install_home_unavailable" => "the Agent home is unavailable",
        "install_manifest_invalid" => "the archive has no valid Agent manifest",
        "install_nothing_to_roll_back" => "there is no previous version to roll back to",
        "install_platform_mismatch" => "the archive is built for another platform",
        "install_sha256_required" => "a downloaded archive needs --sha256",
        "install_switch_failed" => "the active version could not be switched",
        "install_verification_failed" => "the archive does not match the digests in its manifest",
        "install_version_ambiguous" => {
            "several installed directories carry that version; name the directory"
        }
        "install_version_not_found" => "that version is not installed",
        "install_write_failed" => "the Agent home could not be written",
        "update_artifact_sha256_mismatch" => "the archive does not match its sha256",
        _ => "the Agent package operation failed",
    }
}
