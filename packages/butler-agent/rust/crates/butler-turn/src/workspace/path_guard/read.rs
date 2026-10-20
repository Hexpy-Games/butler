use super::*;

/// Guards a read (or listing) of a workspace path: contained, not sensitive,
/// not protected, not escaping through symlinks, and an existing regular file
/// (or directory when allowed).
pub(crate) fn resolve_workspace_path_guard(input: GuardInput<'_>) -> std::io::Result<GuardResult> {
    let (mut out, resolved) = resolve_request(input.root, input.requested, input.path_form)?;
    let Some(resolved) = resolved else {
        return Ok(out);
    };
    let real = resolved.absolute.canonical();
    let projection = real
        .as_ref()
        .cloned()
        .unwrap_or_else(|_| realpath_or_nearest(&resolved.absolute));
    let protected = if input.path_form.contained() {
        std::iter::once(resolved.root_real.join(".project-ledger"))
            .chain(input.protected_roots.iter().cloned())
            .map(|path| realpath_or_nearest(&path))
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let is_protected = |path: &Path| {
        protected
            .iter()
            .any(|root| butler_platform::secure_fs::path_is_within(path, root))
    };
    if !admit_projected(
        &mut out,
        &resolved,
        is_protected(&projection),
        input.path_form,
        input.butler_data,
    ) {
        return Ok(out);
    }
    let Resolved {
        root_real,
        absolute,
    } = resolved;
    let real = match real {
        Ok(real) => real,
        Err(error) => {
            out.reason = Some(super::super::path_messages::io_reason(&error));
            return Ok(out);
        }
    };
    out.real = Some(real.clone());
    if input.path_form.contained() && inside_relative(&root_real, &real).is_none() {
        out.reason = Some("symlink_escape");
        return Ok(out);
    }
    let target_is_protected = is_protected(&real);
    // A1: classification and opening are separate boundaries. A swapped
    // in-project symlink must not turn an ordinary read into a secret read.
    if input.path_form == PathForm::Contained
        && !admit_projected(
            &mut out,
            &Resolved {
                root_real,
                absolute: real,
            },
            target_is_protected,
            input.path_form,
            input.butler_data,
        )
    {
        return Ok(out);
    }
    let meta = std::fs::symlink_metadata(&absolute)?;
    if meta.is_dir() && !input.allow_directories {
        out.reason = Some("directory_not_allowed");
    } else if !(meta.is_dir() || meta.is_file() || meta.file_type().is_symlink()) {
        out.reason = Some("special_file_not_allowed");
    }
    Ok(out)
}
