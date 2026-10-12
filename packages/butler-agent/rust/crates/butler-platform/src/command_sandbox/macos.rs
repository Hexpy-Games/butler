//! The macOS seatbelt: `sandbox-exec` with an inline profile.

use std::path::Path;

use super::{Invocation, ProtectError, Protection, SandboxError};

const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

pub(super) fn read_only_contained(
    invocation: Invocation,
    environment: &std::collections::HashMap<String, String>,
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
    // Credentials stay denied even when the admitted project overlaps a store.
    for root in super::credentials::roots(environment) {
        let real = root.canonicalize().unwrap_or_else(|_| root.clone());
        for path in [&root, &real] {
            let quoted = serde_json::to_string(&path.to_string_lossy())?;
            profile.push_str(&format!("\n(deny file-read* (subpath {quoted}))"));
        }
    }
    for root in allowed {
        let real = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        for path in [*root, real.as_path()] {
            deny_project_secrets(&mut profile, path)?;
        }
    }
    Ok(sandboxed(profile, invocation))
}

// Seatbelt rules are ordered: these exclusions must follow the project allow.
fn deny_project_secrets(profile: &mut String, root: &Path) -> Result<(), SandboxError> {
    let root = root
        .to_string_lossy()
        .chars()
        .fold(String::new(), |mut out, ch| {
            if r"\.^$|?*+()[]{}".contains(ch) {
                out.push('\\');
            }
            out.push(ch);
            out
        });
    let names = format!("({})", super::credentials::secret_pattern());
    let names = names
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphabetic() {
                format!("[{ch}{}]", ch.to_ascii_uppercase())
            } else {
                ch.to_string()
            }
        })
        .collect::<String>();
    let pattern = format!("^{root}/(.*/)?{names}(/|$)");
    let quoted = serde_json::to_string(&pattern)?;
    profile.push_str(&format!("\n(deny file-read* (regex {quoted}))"));
    Ok(())
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
        restore_cwd: false,
        raw_cmd_script: false,
        program: SANDBOX_EXEC.into(),
        arguments,
    }
}
