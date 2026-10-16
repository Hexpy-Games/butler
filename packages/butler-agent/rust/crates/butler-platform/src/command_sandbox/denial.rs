//! Model-facing feedback for Linux kernel denials, never a user notice.

/// Adds cautious feedback to Linux permission failures. Stderr alone cannot
/// distinguish a sandbox denial from DAC, another LSM, or application output.
/// Call only for failed commands actually run with read-only access.
pub fn sandbox_denial(stderr: &str) -> Option<(&'static str, &'static str)> {
    #[cfg(target_os = "linux")]
    {
        let text = stderr.to_ascii_lowercase();
        if ![
            "permission denied",
            "operation not permitted",
            "read-only file system",
            "device or resource busy",
        ]
        .iter()
        .any(|signature| text.contains(signature))
        {
            return None;
        }
        Some((
            "possible",
            "This command may have been denied by the sandbox. Check the requested operation, paths and ordinary filesystem permissions. Only if it needs writes or network access, request approval with state_effect \"mutation\" or \"remote_observation\", respectively.",
        ))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = stderr;
        None
    }
}

/// Recognizes a trampoline setup failure without confusing a shell's exit 125.
pub fn isolation_failure(exit_code: Option<i32>, stderr: &[u8]) -> bool {
    isolation_failure_exit(exit_code)
        && stderr.starts_with(b"command_observation_isolation_unavailable:")
}

/// Whether this host can report a trampoline setup failure at this exit code.
pub fn isolation_failure_exit(exit_code: Option<i32>) -> bool {
    cfg!(any(target_os = "linux", windows)) && exit_code == Some(125)
}

/// Reserved helper timeout status, qualified by its trailing stderr marker.
pub const EXECUTION_TIMEOUT_EXIT: i32 = 124;
/// Emitted only when MXC reports a timed out container after draining output.
pub const EXECUTION_TIMEOUT_MARKER: &str = "butler_command_execution_timed_out";
/// Whether an exit needs timeout-marker inspection.
pub fn execution_timeout_exit(exit_code: Option<i32>) -> bool {
    cfg!(windows) && exit_code == Some(EXECUTION_TIMEOUT_EXIT)
}
/// Distinguishes an MXC timeout from a command which itself exits 124.
pub fn execution_timeout(exit_code: Option<i32>, stderr_tail: &[u8]) -> bool {
    execution_timeout_exit(exit_code)
        && stderr_tail
            .trim_ascii_end()
            .ends_with(EXECUTION_TIMEOUT_MARKER.as_bytes())
}

/// Helper execution/capture failure, distinct from a policy setup refusal.
pub const EXECUTION_FAILURE_EXIT: i32 = 126;
/// Trailer emitted after reporting a failed wait or incomplete output relay.
pub const EXECUTION_FAILURE_MARKER: &str = "butler_command_execution_failed";
/// Recognizes an explicit Windows helper execution failure.
pub fn execution_failure(exit_code: Option<i32>, tail: &[u8]) -> bool {
    cfg!(windows)
        && exit_code == Some(EXECUTION_FAILURE_EXIT)
        && tail
            .trim_ascii_end()
            .ends_with(EXECUTION_FAILURE_MARKER.as_bytes())
}

/// Whether this host can emit the execution failure protocol.
pub fn execution_failure_exit(exit_code: Option<i32>) -> bool {
    cfg!(windows) && exit_code == Some(EXECUTION_FAILURE_EXIT)
}
