use butler_platform::secure_fs::Canonical as _;
use std::path::{Component, Path, PathBuf};

use serde_json::{Value, json};

/// Whether a requested path must be workspace-relative (delegated
/// subsessions) or may also be absolute inside the workspace.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathForm {
    RelativeOnly,
    RelativeOrAbsolute,
}

/// Whether a mutation target's final component must already exist.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Leaf {
    MustExist,
    MayBeMissing,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct GuardInput<'a> {
    pub root: &'a Path,
    pub requested: &'a str,
    pub path_form: PathForm,
    pub allow_directories: bool,
    pub protected_roots: &'a [PathBuf],
}

#[derive(Clone, Copy)]
pub(crate) struct MutationGuardInput<'a> {
    pub root: &'a Path,
    pub requested: &'a str,
    pub path_form: PathForm,
    pub leaf: Leaf,
    pub installation_root: Option<&'a Path>,
    pub protected_roots: &'a [PathBuf],
}

#[derive(Clone, Debug)]
pub struct GuardResult {
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
    /// For an accepted path: the lexical absolute path and the path to open
    /// (its real path when resolved, otherwise the absolute path).
    pub(crate) fn accepted(&self) -> Option<(&Path, &Path)> {
        if !self.ok() {
            return None;
        }
        let absolute = self.absolute.as_deref()?;
        Some((absolute, self.real.as_deref().unwrap_or(absolute)))
    }
    pub fn safe_path(&self) -> Option<String> {
        let candidate = match &self.absolute {
            Some(path) => butler_platform::secure_fs::relative_path(path, &self.root)?
                .to_string_lossy()
                .into_owned(),
            None => butler_core::public_text::trim_js_whitespace(&self.requested).to_owned(),
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
    /// The model-facing rejection of a refused path.
    pub fn public_rejection(&self) -> Value {
        let mut result = serde_json::Map::new();
        result.insert("ok".into(), json!(false));
        result.insert("workspace_root".into(), json!(self.root));
        if let Some(path) = self.safe_path() {
            result.insert("path".into(), json!(path));
        }
        if let Some(reason) = self.reason {
            result.insert("reason".into(), json!(reason));
        }
        if matches!(
            self.reason,
            Some("path_escape" | "symlink_escape" | "parent_escape")
        ) {
            result.insert(
                "message".into(),
                json!("Use a path inside the session workspace root."),
            );
        }
        if self.protected {
            result.insert("code".into(), json!("protected_path"));
            result.insert(
                "message".into(),
                json!(
                    "Butler data and credential paths must be accessed through their dedicated tools."
                ),
            );
            result.insert(
                "next".into(),
                json!([{ "action": "Use the admitted Butler tools for protected data; choose ordinary user files for file tools." }]),
            );
        }
        Value::Object(result)
    }
}

/// A request resolved against the canonical workspace root, before any
/// containment check.
struct Resolved {
    root_real: PathBuf,
    absolute: PathBuf,
}

/// Starts a guard result and lexically resolves the request. Empty requests,
/// absolute requests in relative-only mode and relative `..` traversal are
/// rejected without touching the filesystem beyond the root.
fn resolve_request(
    root: &Path,
    requested: &str,
    path_form: PathForm,
) -> std::io::Result<(GuardResult, Option<Resolved>)> {
    let root_lex = lexical_absolute(root)?;
    let mut out = GuardResult {
        root: root_lex.clone(),
        requested: requested.to_owned(),
        absolute: None,
        real: None,
        reason: None,
        protected: false,
    };
    if requested.is_empty() {
        out.reason = Some("missing_path");
        return Ok((out, None));
    }
    let requested_path = Path::new(requested);
    if path_form == PathForm::RelativeOnly && requested_path.is_absolute() {
        out.reason = Some("absolute_path_not_allowed");
        return Ok((out, None));
    }
    let root_real = root_lex.canonical()?;
    out.root = root_real.clone();
    if !requested_path.is_absolute() && has_parent_segment(requested) {
        out.reason = Some("parent_traversal_not_allowed");
        return Ok((out, None));
    }
    let unresolved = if requested_path.is_absolute() {
        lexical_absolute(requested_path)?
    } else {
        lexical_absolute(&root_lex.join(requested))?
    };
    let absolute = match inside_relative(&root_lex, &unresolved) {
        Some(relative) => root_real.join(relative),
        None => realpath_or_nearest(&unresolved),
    };
    Ok((
        out,
        Some(Resolved {
            root_real,
            absolute,
        }),
    ))
}

/// Records the absolute path and rejects paths outside the root, sensitive
/// paths and protected roots. Returns whether the path is still admitted.
fn admit_contained(
    out: &mut GuardResult,
    resolved: &Resolved,
    protected_roots: &[PathBuf],
) -> bool {
    let Resolved {
        root_real,
        absolute,
    } = resolved;
    out.absolute = Some(absolute.clone());
    if protected_path(root_real, absolute, protected_roots) {
        out.reason = Some("protected_path");
        out.protected = true;
        return false;
    }
    let Some(relative) = inside_relative(root_real, absolute) else {
        out.reason = Some("path_escape");
        return false;
    };
    if looks_sensitive(&relative.to_string_lossy()) {
        out.reason = Some("sensitive_path_blocked");
        return false;
    }
    true
}

/// Guards a read (or listing) of a workspace path: contained, not sensitive,
/// not protected, not escaping through symlinks, and an existing regular file
/// (or directory when allowed).
pub(crate) fn resolve_workspace_path_guard(input: GuardInput<'_>) -> std::io::Result<GuardResult> {
    let (mut out, resolved) = resolve_request(input.root, input.requested, input.path_form)?;
    let Some(resolved) = resolved else {
        return Ok(out);
    };
    if !admit_contained(&mut out, &resolved, input.protected_roots) {
        return Ok(out);
    }
    let Resolved {
        root_real,
        absolute,
    } = resolved;
    let Ok(real) = absolute.canonical() else {
        out.reason = Some("not_found");
        return Ok(out);
    };
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
    Ok(out)
}

/// The lexical and real paths of the Butler installation, which is never writable.
struct Installation(Option<(PathBuf, PathBuf)>);

impl Installation {
    fn resolve(root: Option<&Path>) -> std::io::Result<Self> {
        let paths = root
            .map(|home| {
                let lexical = lexical_absolute(home)?;
                let real = lexical.canonical().unwrap_or_else(|_| lexical.clone());
                Ok::<_, std::io::Error>((lexical, real))
            })
            .transpose()?;
        Ok(Self(paths))
    }

    fn contains(&self, candidate: &Path) -> bool {
        self.0.as_ref().is_some_and(|(lexical, real)| {
            butler_platform::secure_fs::path_is_within(candidate, lexical)
                || butler_platform::secure_fs::path_is_within(candidate, real)
        })
    }
}

/// Guards a write: the read checks plus the read-only installation, and an
/// optional missing leaf whose nearest existing parent must stay contained.
pub(crate) fn resolve_workspace_mutation_guard(
    input: MutationGuardInput<'_>,
) -> std::io::Result<GuardResult> {
    let (mut out, resolved) = resolve_request(input.root, input.requested, input.path_form)?;
    let Some(resolved) = resolved else {
        return Ok(out);
    };
    let installation = Installation::resolve(input.installation_root)?;
    if installation.contains(&resolved.absolute) {
        out.reason = Some("program_directory_read_only");
        return Ok(out);
    }
    if !admit_contained(&mut out, &resolved, input.protected_roots) {
        return Ok(out);
    }
    let Resolved {
        root_real,
        absolute,
    } = resolved;
    match absolute.canonical() {
        Ok(real) => {
            out.real = Some(real.clone());
            out.reason = existing_target_rejection(&root_real, &absolute, &real, &installation)?;
        }
        Err(_) if input.leaf == Leaf::MayBeMissing => {
            let parent = absolute.parent().unwrap_or(&root_real);
            let parent_real = realpath_or_nearest(parent);
            if installation.contains(&parent_real) {
                out.reason = Some("program_directory_read_only");
            } else if inside_relative(&root_real, &parent_real).is_none() {
                out.reason = Some("parent_escape");
            } else {
                match absolute.file_name() {
                    Some(leaf) => out.real = Some(parent_real.join(leaf)),
                    None => out.reason = Some("parent_escape"),
                }
            }
        }
        Err(_) => out.reason = Some("not_found"),
    }
    Ok(out)
}

/// Why an existing write target is refused: installation, symlink escape,
/// directory or special file.
fn existing_target_rejection(
    root_real: &Path,
    absolute: &Path,
    real: &Path,
    installation: &Installation,
) -> std::io::Result<Option<&'static str>> {
    if installation.contains(real) {
        return Ok(Some("program_directory_read_only"));
    }
    if inside_relative(root_real, real).is_none() {
        return Ok(Some("symlink_escape"));
    }
    let meta = std::fs::symlink_metadata(absolute)?;
    Ok(if meta.is_dir() {
        Some("directory_not_allowed")
    } else if !(meta.is_file() || meta.file_type().is_symlink()) {
        Some("special_file_not_allowed")
    } else {
        None
    })
}

/// A trimmed relative path without traversal, home or drive prefixes.
pub fn safe_workspace_path(path: &str) -> Option<&str> {
    let trimmed = butler_core::public_text::trim_js_whitespace(path);
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
pub fn looks_sensitive(relative: &str) -> bool {
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
        && !butler_core::public_text::trim_js_whitespace(&data).is_empty()
    {
        let data = PathBuf::from(data);
        roots.push(data.join("project-ledger/projects"));
        protect_external_data(root, &data, &mut roots);
    }
    if let Some(home) = butler_platform::user_dirs::home_dir() {
        let data = home.join(".butler");
        roots.push(data.join("project-ledger/projects"));
        protect_external_data(root, &data, &mut roots);
    }
    roots.extend_from_slice(extra);
    roots.into_iter().any(|candidate| {
        butler_platform::secure_fs::path_is_within(&target, &realpath_or_nearest(&candidate))
    })
}
fn protect_external_data(root: &Path, data: &Path, roots: &mut Vec<PathBuf>) {
    // Preserve dedicated file-tool access to an admitted legacy workspace.
    // A different workspace cannot use file tools to enter Butler's data tree.
    if !butler_platform::secure_fs::path_is_within(root, &realpath_or_nearest(data)) {
        roots.push(data.to_path_buf());
    }
}

pub(crate) fn realpath_or_nearest(path: &Path) -> PathBuf {
    let mut current = path.to_path_buf();
    let mut suffix = Vec::new();
    loop {
        if let Ok(real) = current.canonical() {
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
fn inside_relative(root: &Path, candidate: &Path) -> Option<PathBuf> {
    let relative = butler_platform::secure_fs::relative_path(candidate, root)?;
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
