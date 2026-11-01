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
            let real = crate::secure_fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
            for path in [*root, real.as_path()] {
                let quoted = serde_json::to_string(&path.to_string_lossy())?;
                profile.push_str(&format!("\n({action} file-read* (subpath {quoted}))"));
            }
        }
    }
    // Credentials stay denied even when the admitted project overlaps a store.
    for root in super::credentials::roots(environment) {
        let real = crate::secure_fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
        for path in [&root, &real] {
            let quoted = serde_json::to_string(&path.to_string_lossy())?;
            profile.push_str(&format!("\n(deny file-read* (subpath {quoted}))"));
        }
    }
    for root in allowed {
        let real = crate::secure_fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        for path in [*root, real.as_path()] {
            deny_project_secrets(&mut profile, path, "file-read*")?;
        }
    }
    Ok(sandboxed(profile, invocation))
}

/// Writes only inside `root` and the `writable` scratch roots, never below
/// `denied`, project metadata or secrets; no network. Seatbelt rules are
/// ordered and the last match wins, so each exclusion follows its allow.
pub(super) fn project_write(
    invocation: Invocation,
    environment: &std::collections::HashMap<String, String>,
    root: &Path,
    writable: &[&Path],
    denied: &[&Path],
    _toolchain_roots: Option<&crate::command_sandbox::ToolchainRoots>,
) -> Result<Invocation, SandboxError> {
    let mut profile = ["(version 1)", "(allow default)", "(deny file-write*)"].join("\n");
    let rule = |profile: &mut String, rule: &str, paths: &[&Path]| {
        for path in paths {
            let real = crate::secure_fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
            for path in [*path, real.as_path()] {
                let quoted = serde_json::to_string(&path.to_string_lossy())?;
                profile.push_str(&format!("\n({rule} (subpath {quoted}))"));
            }
        }
        Ok::<_, SandboxError>(())
    };
    rule(&mut profile, "allow file-write*", &[root])?;
    rule(&mut profile, "deny file-write*", denied)?;
    rule(&mut profile, "allow file-write*", writable)?;
    profile.push_str("\n(allow file-write-data (literal \"/dev/null\"))");
    let real = crate::secure_fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    for path in [root, real.as_path()] {
        deny_project_secrets(&mut profile, path, "file-write*")?;
        deny_project_secrets(&mut profile, path, "file-read*")?;
    }
    for credential in super::credentials::roots(environment) {
        rule(&mut profile, "deny file-read*", &[credential.as_path()])?;
        rule(&mut profile, "deny file-write*", &[credential.as_path()])?;
    }
    profile.push_str("\n(deny network*)");
    Ok(sandboxed(profile, invocation))
}

// Seatbelt rules are ordered: these exclusions must follow the project allow.
fn deny_project_secrets(
    profile: &mut String,
    root: &Path,
    operation: &str,
) -> Result<(), SandboxError> {
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
    profile.push_str(&format!("\n(deny {operation} (regex {quoted}))"));
    Ok(())
}

pub(super) fn protect_writes(
    invocation: Invocation,
    root: &Path,
) -> Result<Protection, ProtectError> {
    let lexical = root.to_path_buf();
    let real = crate::secure_fs::canonicalize(&lexical).unwrap_or_else(|_| lexical.clone());
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

/// The user's own access, except that credential roots stay unreadable and
/// unmovable: no reads or writes below them, and no rename of a root or of
/// any directory above it (that would move a secret out from under its rule).
/// The kernel resolves links, aliases and case, so no shell is interpreted.
/// `write_protected` keeps the legacy installation-root write denial.
pub(super) fn deny_secret_reads(
    invocation: Invocation,
    environment: &std::collections::HashMap<String, String>,
    write_protected: Option<&Path>,
) -> Result<Invocation, SandboxError> {
    let mut profile = ["(version 1)", "(allow default)"].join("\n");
    let both = |path: &Path| {
        let real = crate::secure_fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        [path.to_path_buf(), real]
    };
    let mut ancestors = std::collections::BTreeSet::new();
    for root in super::credentials::roots(environment) {
        for path in both(&root) {
            let quoted = serde_json::to_string(&path.to_string_lossy())?;
            profile.push_str(&format!(
                "\n(deny file-read* file-write* (subpath {quoted}))"
            ));
            ancestors.extend(path.ancestors().skip(1).map(Path::to_path_buf));
        }
    }
    for ancestor in ancestors {
        let quoted = serde_json::to_string(&ancestor.to_string_lossy())?;
        profile.push_str(&format!("\n(deny file-write* (literal {quoted}))"));
    }
    for path in write_protected.map(both).into_iter().flatten() {
        let quoted = serde_json::to_string(&path.to_string_lossy())?;
        profile.push_str(&format!("\n(deny file-write* (subpath {quoted}))"));
    }
    // Seatbelt rules are ordered: this exception follows the denial.
    for path in super::credentials::ssh_agent_readable(environment)
        .iter()
        .flat_map(|path| both(path))
    {
        let quoted = serde_json::to_string(&path.to_string_lossy())?;
        profile.push_str(&format!("\n(allow file-read* (literal {quoted}))"));
    }
    Ok(sandboxed(profile, invocation))
}

/// `invocation` run by `sandbox-exec` under `profile`.
fn sandboxed(profile: String, invocation: Invocation) -> Invocation {
    let mut arguments = vec!["-p".into(), profile, invocation.program];
    arguments.extend(invocation.arguments);
    Invocation {
        program: SANDBOX_EXEC.into(),
        arguments,
        ..Default::default()
    }
}
