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
    cfg!(target_os = "linux") && exit_code == Some(125)
}
