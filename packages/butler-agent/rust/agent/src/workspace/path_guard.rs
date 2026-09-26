use std::path::{Component, Path, PathBuf};

use serde_json::{Value, json};

#[derive(Clone, Debug)]
pub(crate) struct GuardInput<'a> {
    pub root: &'a Path,
    pub requested: &'a str,
    pub relative_only: bool,
    pub allow_directories: bool,
    pub protected_roots: &'a [PathBuf],
}

pub(crate) struct MutationGuardInput<'a> {
    pub root: &'a Path,
    pub requested: &'a str,
    pub relative_only: bool,
    pub allow_missing_leaf: bool,
    pub installation_root: Option<&'a Path>,
    pub protected_roots: &'a [PathBuf],
}

#[derive(Clone, Debug)]
pub(crate) struct GuardResult {
    pub root: PathBuf,
    pub requested: String,
    pub absolute: Option<PathBuf>,
    pub real: Option<PathBuf>,
    pub reason: Option<&'static str>,
    pub protected: bool,
}

impl GuardResult {
    pub(crate) fn ok(&self) -> bool {
        self.reason.is_none()
    }
    pub(crate) fn safe_path(&self) -> Option<String> {
        let candidate = match &self.absolute {
            Some(path) => path
                .strip_prefix(&self.root)
                .ok()?
                .to_string_lossy()
                .into_owned(),
            None => crate::public_text::trim_js_whitespace(&self.requested).to_owned(),
        };
        if candidate.is_empty()
            || candidate == "."
            || Path::new(&candidate).is_absolute()
            || has_parent_segment(&candidate)
        {
            None
        } else {
            Some(candidate.replace('\\', "/"))
        }
    }
    pub(crate) fn public_rejection(&self) -> Value {
        let mut result = json!({ "ok": false });
        if let Some(path) = self.safe_path() {
            result["path"] = json!(path);
        }
        if let Some(reason) = self.reason {
            result["reason"] = json!(reason);
        }
        if self.protected {
            result["code"] = json!("protected_path");
            result["message"] = json!(
                "Project Ledger source records must be mutated through Project Ledger commands."
            );
            result["next"] =
                json!([{ "command": "project-ledger record update --id <id> --from FILE|-" }]);
        }
        result
    }
}

pub(crate) fn resolve_workspace_path_guard(input: GuardInput<'_>) -> std::io::Result<GuardResult> {
    let requested = input.requested.to_owned();
    let root_lex = lexical_absolute(input.root)?;
    let mut out = GuardResult {
        root: root_lex.clone(),
        requested,
        absolute: None,
        real: None,
        reason: None,
        protected: false,
    };
    if input.requested.is_empty() {
        out.reason = Some("missing_path");
        return Ok(out);
    }
    if input.relative_only && Path::new(input.requested).is_absolute() {
        out.reason = Some("absolute_path_not_allowed");
        return Ok(out);
    }
    let root_real = root_lex.canonicalize()?;
    out.root = root_real.clone();
    if !Path::new(input.requested).is_absolute() && has_parent_segment(input.requested) {
        out.reason = Some("parent_traversal_not_allowed");
        return Ok(out);
    }
    let unresolved = if Path::new(input.requested).is_absolute() {
        lexical_absolute(Path::new(input.requested))?
    } else {
        lexical_absolute(&root_lex.join(input.requested))?
    };
    let absolute = if let Some(relative) = inside_relative(&root_lex, &unresolved) {
        root_real.join(relative)
    } else {
        unresolved
    };
    out.absolute = Some(absolute.clone());
    if inside_relative(&root_real, &absolute).is_none() {
        out.reason = Some("path_escape");
        return Ok(out);
    }
    let relative = absolute
        .strip_prefix(&root_real)
        .expect("root containment")
        .to_string_lossy();
    if looks_sensitive(&relative) {
        out.reason = Some("sensitive_path_blocked");
        return Ok(out);
    }
    if protected_path(&root_real, &absolute, input.protected_roots) {
        out.reason = Some("protected_path");
        out.protected = true;
        return Ok(out);
    }
    match absolute.canonicalize() {
        Ok(real) => {
            out.real = Some(real.clone());
            if inside_relative(&root_real, &real).is_none() {
                out.reason = Some("symlink_escape");
                return Ok(out);
            }
            let meta = std::fs::symlink_metadata(&absolute)?;
            if meta.is_dir() && !input.allow_directories {
                out.reason = Some("directory_not_allowed");
            } else if !(meta.is_dir() || meta.is_file() || meta.file_type().is_symlink()) {
                out.reason = Some("special_file_not_allowed");
            }
        }
        Err(_) => {
            out.reason = Some("not_found");
        }
    }
    Ok(out)
}

pub(crate) fn resolve_workspace_mutation_guard(
    input: MutationGuardInput<'_>,
) -> std::io::Result<GuardResult> {
    let root_lex = lexical_absolute(input.root)?;
    let mut out = GuardResult {
        root: root_lex.clone(),
        requested: input.requested.to_owned(),
        absolute: None,
        real: None,
        reason: None,
        protected: false,
    };
    if input.requested.is_empty() {
        out.reason = Some("missing_path");
        return Ok(out);
    }
    if input.relative_only && Path::new(input.requested).is_absolute() {
        out.reason = Some("absolute_path_not_allowed");
        return Ok(out);
    }
    let root_real = root_lex.canonicalize()?;
    out.root = root_real.clone();
    if !Path::new(input.requested).is_absolute() && has_parent_segment(input.requested) {
        out.reason = Some("parent_traversal_not_allowed");
        return Ok(out);
    }
    let unresolved = if Path::new(input.requested).is_absolute() {
        lexical_absolute(Path::new(input.requested))?
    } else {
        lexical_absolute(&root_lex.join(input.requested))?
    };
    let absolute = if let Some(relative) = inside_relative(&root_lex, &unresolved) {
        root_real.join(relative)
    } else {
        unresolved
    };
    let installation = input
        .installation_root
        .map(|home| {
            let lexical = lexical_absolute(home)?;
            let real = lexical.canonicalize().unwrap_or_else(|_| lexical.clone());
            Ok::<_, std::io::Error>((lexical, real))
        })
        .transpose()?;
    if let Some((home_lex, home_real)) = &installation
        && (absolute.starts_with(home_lex) || absolute.starts_with(home_real))
    {
        out.reason = Some("program_directory_read_only");
        return Ok(out);
    }
    let inside_installation = |candidate: &Path| {
        installation.as_ref().is_some_and(|(lexical, real)| {
            candidate.starts_with(lexical) || candidate.starts_with(real)
        })
    };
    out.absolute = Some(absolute.clone());
    if inside_relative(&root_real, &absolute).is_none() {
        out.reason = Some("path_escape");
        return Ok(out);
    }
    let relative = absolute
        .strip_prefix(&root_real)
        .expect("contained")
        .to_string_lossy();
    if looks_sensitive(&relative) {
        out.reason = Some("sensitive_path_blocked");
        return Ok(out);
    }
    if protected_path(&root_real, &absolute, input.protected_roots) {
        out.reason = Some("protected_path");
        out.protected = true;
        return Ok(out);
    }
    match absolute.canonicalize() {
        Ok(real) => {
            out.real = Some(real.clone());
            if inside_installation(&real) {
                out.reason = Some("program_directory_read_only");
                return Ok(out);
            }
            if inside_relative(&root_real, &real).is_none() {
                out.reason = Some("symlink_escape");
                return Ok(out);
            }
            let meta = std::fs::symlink_metadata(&absolute)?;
            if meta.is_dir() {
                out.reason = Some("directory_not_allowed");
            } else if !(meta.is_file() || meta.file_type().is_symlink()) {
                out.reason = Some("special_file_not_allowed");
            }
        }
        Err(_) if input.allow_missing_leaf => {
            let parent = absolute.parent().unwrap_or(&root_real);
            let parent_real = realpath_or_nearest(parent);
            if inside_installation(&parent_real) {
                out.reason = Some("program_directory_read_only");
            } else if inside_relative(&root_real, &parent_real).is_none() {
                out.reason = Some("parent_escape");
            } else {
                out.real = Some(parent_real.join(absolute.strip_prefix(parent).expect("child")));
            }
        }
        Err(_) => out.reason = Some("not_found"),
    }
    Ok(out)
}

pub(crate) fn safe_workspace_path(path: &str) -> Option<&str> {
    let trimmed = crate::public_text::trim_js_whitespace(path);
    if trimmed.is_empty()
        || trimmed.starts_with(['/', '\\', '~'])
        || has_parent_segment(trimmed)
        || has_drive_prefix(trimmed)
    {
        None
    } else {
        Some(trimmed)
    }
}

pub(crate) fn safe_cursor_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with(['/', '\\', '~'])
        && !has_parent_segment(path)
        && !has_drive_prefix(path)
}

fn has_drive_prefix(value: &str) -> bool {
    value.as_bytes().get(1) == Some(&b':')
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
}
fn has_parent_segment(value: &str) -> bool {
    value.split(['/', '\\']).any(|part| part == "..")
}
pub(super) fn looks_sensitive(relative: &str) -> bool {
    let parts: Vec<_> = relative
        .split(['/', '\\'])
        .filter(|part| !part.is_empty())
        .collect();
    parts.iter().enumerate().any(|(index, part)| {
        let lower = part.to_lowercase();
        matches!(
            lower.as_str(),
            ".git"
                | ".ssh"
                | ".gnupg"
                | "chatgpt-oauth.json"
                | "credentials.json"
                | "secrets.json"
                | "id_rsa"
                | "id_ed25519"
        ) || lower.ends_with(".pem")
            || lower.ends_with(".key")
            || index + 1 == parts.len() && lower.starts_with(".env")
    })
}
pub(super) fn protected_path(root: &Path, target: &Path, extra: &[PathBuf]) -> bool {
    let target = realpath_or_nearest(target);
    let mut roots = vec![root.join(".project-ledger")];
    if let Ok(data) = std::env::var("BUTLER_DATA")
        && !crate::public_text::trim_js_whitespace(&data).is_empty()
    {
        roots.push(PathBuf::from(data).join("project-ledger/projects"));
    }
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        roots.push(PathBuf::from(home).join(".butler/project-ledger/projects"));
    }
    roots.extend_from_slice(extra);
    roots
        .into_iter()
        .any(|candidate| target.starts_with(realpath_or_nearest(&candidate)))
}
fn realpath_or_nearest(path: &Path) -> PathBuf {
    let mut current = path.to_path_buf();
    let mut suffix = Vec::new();
    loop {
        if let Ok(real) = current.canonicalize() {
            return suffix
                .into_iter()
                .rev()
                .fold(real, |path, component| path.join(component));
        }
        let Some(name) = current.file_name() else {
            return path.to_path_buf();
        };
        suffix.push(name.to_os_string());
        let Some(parent) = current.parent() else {
            return path.to_path_buf();
        };
        current = parent.to_path_buf();
    }
}
fn inside_relative<'a>(root: &Path, candidate: &'a Path) -> Option<&'a Path> {
    let relative = candidate.strip_prefix(root).ok()?;
    // Node's isInside uses path.relative and rejects any result beginning
    // with "..", including a contained filename such as "..notes".
    (!relative.to_string_lossy().starts_with("..")).then_some(relative)
}
pub(crate) fn lexical_absolute(path: &Path) -> std::io::Result<PathBuf> {
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
