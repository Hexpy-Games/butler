//! OS process identity used to validate service records before signaling,
//! read through `butler_platform::instance` and reported with the service's
//! error codes.

use butler_platform::instance::{self as platform, IdentityError};
use butler_platform::process_control::{Liveness, liveness};

/// A CLI supervisor supplies a fresh identity before spawning each child so
/// exit handling can compare stop intents even after the record is removed.
pub(crate) const CLI_SUPERVISOR_NONCE: &str = "BUTLER_CLI_SUPERVISOR_NONCE";

pub(crate) fn instance_nonce() -> String {
    std::env::var(CLI_SUPERVISOR_NONCE)
        .ok()
        .and_then(|value| uuid::Uuid::parse_str(&value).ok())
        .unwrap_or_else(uuid::Uuid::new_v4)
        .to_string()
}

/// Whether a process's executable as the OS reports it (`observed`) is the
/// recorded one (`expected`): the same file, whatever name the OS used.
pub(crate) fn executable_matches(expected: &str, observed: &str) -> bool {
    platform::same_executable(expected, observed)
}

/// Whether a process has `pid`, including one owned by another user.
pub(crate) fn process_is_alive(pid: u32) -> Result<bool, crate::host::HostError> {
    match liveness(pid) {
        Liveness::Running | Liveness::OtherOwner => Ok(true),
        Liveness::Gone => Ok(false),
        Liveness::Unknown => {
            Err("native_service_process_probe_failed: the process table could not be read".into())
        }
    }
}

/// When process `pid` started (see `butler_platform::instance::process_start`).
pub(crate) fn process_start_identity(pid: u32) -> Result<Option<String>, crate::host::HostError> {
    platform::process_start(pid)
        .map_err(|error| identity_error(error, "native_service_process_identity_unavailable"))
}

/// The executable process `pid` runs.
pub(crate) fn process_executable(pid: u32) -> Result<Option<String>, crate::host::HostError> {
    platform::process_executable(pid)
        .map_err(|error| identity_error(error, "native_service_process_executable_unavailable"))
}

/// The service's error for an identity that could not be read; `unavailable`
/// is the code of a process whose identity the host did not report.
pub(crate) fn identity_error(
    error: IdentityError,
    unavailable: &'static str,
) -> crate::host::HostError {
    let message = match &error {
        IdentityError::Unavailable(_) => unavailable.to_owned(),
        IdentityError::Probe(detail) => format!("native_service_process_probe_failed: {detail}"),
        IdentityError::Unsupported => "native_service_process_identity_unsupported".to_owned(),
    };
    crate::host::HostError::new(message).with_source(error)
}
