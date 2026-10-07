//! The macOS seatbelt: `sandbox-exec` with an inline profile.

use std::path::Path;

use super::{Invocation, ProtectError, Protection, SandboxError};

pub(super) const ENFORCED: bool = true;

const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

pub(super) fn read_only(invocation: Invocation) -> Result<Invocation, SandboxError> {
    read_only_contained(invocation, &[], &[])
}

pub(super) fn read_only_contained(
    invocation: Invocation,
    denied: &[&Path],
    allowed: &[&Path],
) -> Result<Invocation, SandboxError> {
    let mut profile = [
        "(version 1)",
        "(allow default)",
        "(deny file-write*)",
        "(allow file-write-data (literal \"/dev/null\"))",
        "(deny network*)",
    ]
    .join("\n");
    for (action, roots) in [("deny", denied), ("allow", allowed)] {
        for root in roots {
            let real = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
            for path in [*root, real.as_path()] {
                let quoted = serde_json::to_string(&path.to_string_lossy())?;
                profile.push_str(&format!("\n({action} file-read* (subpath {quoted}))"));
            }
        }
    }
    Ok(sandboxed(profile, invocation))
}

pub(super) fn protect_writes(
    invocation: Invocation,
    root: &Path,
) -> Result<Protection, ProtectError> {
    let lexical = root.to_path_buf();
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
    Ok(Protection::Enforced(sandboxed(profile, invocation)))
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
