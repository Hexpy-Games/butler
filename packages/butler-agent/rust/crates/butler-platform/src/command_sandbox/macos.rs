//! The macOS seatbelt: `sandbox-exec` with an inline profile.

use std::path::{Component, Path, PathBuf};

use super::{Invocation, ProtectError, SandboxError};

const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

pub(super) fn read_only(invocation: Invocation) -> Result<Invocation, SandboxError> {
    let profile = [
        "(version 1)",
        "(allow default)",
        "(deny file-write*)",
        "(allow file-write-data (literal \"/dev/null\"))",
        "(deny network*)",
    ]
    .join("\n");
    Ok(sandboxed(profile, invocation))
}

pub(super) fn protect_writes(
    invocation: Invocation,
    root: &Path,
) -> Result<Invocation, ProtectError> {
    let lexical = lexical_absolute(root).map_err(ProtectError::Io)?;
    let real = lexical.canonicalize().unwrap_or_else(|_| lexical.clone());
    let mut roots = vec![lexical];
    if roots.first() != Some(&real) {
        roots.push(real);
    }
    let mut clauses = Vec::with_capacity(roots.len());
    for root in roots {
        let quoted = serde_json::to_string(&root.to_string_lossy().as_ref())
            .map_err(ProtectError::Profile)?;
        clauses.push(format!("(subpath {quoted})"));
    }
    let profile = format!(
        "(version 1)(allow default)(deny file-write* {})",
        clauses.join(" ")
    );
    Ok(sandboxed(profile, invocation))
}

/// `invocation` run by `sandbox-exec` under `profile`.
fn sandboxed(profile: String, invocation: Invocation) -> Invocation {
    let mut arguments = vec!["-p".into(), profile, invocation.program];
    arguments.extend(invocation.arguments);
    Invocation {
        program: SANDBOX_EXEC.into(),
        arguments,
    }
}

/// `path` made absolute against the working directory, with `.` and `..`
/// resolved lexically (symlinks are not followed).
fn lexical_absolute(path: &Path) -> std::io::Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut clean = PathBuf::new();
    for part in absolute.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                clean.pop();
            }
            other => clean.push(other.as_os_str()),
        }
    }
    Ok(clean)
}
