//! Model-facing feedback for Linux kernel denials, never a user notice.

/// Identifies Linux read-only failures that need an explicitly different effect.
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
        if ["socket", "connect", "network", "/dev/tcp", "/dev/udp"]
            .iter()
            .any(|signature| text.contains(signature))
        {
            return Some((
                "network",
                "This command ran read-only and was denied network access. If it must use the network, rerun it with state_effect \"remote_observation\" to request approval.",
            ));
        }
        Some((
            "write",
            "This command ran read-only and was denied write access. If it must write, rerun it with state_effect \"mutation\" to request approval.",
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
    exit_code == Some(125) && stderr.starts_with(b"command_observation_isolation_unavailable:")
}
