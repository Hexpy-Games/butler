//! Partial shell interpretation for lexical guards. Incomplete means unknown,
//! never safe: arbitrary programs require kernel credential-read protection.
mod expansion;
mod glob;
mod words;
use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
};

/// Shell grammar, explicit so foreign shell forms can be tested on any host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathSyntax {
    /// POSIX shell quoting and environment expansion.
    Posix,
    /// PowerShell environment provider and automatic home variable.
    PowerShell,
    /// cmd.exe percent expansion and caret escaping.
    Cmd,
}

/// A shell word and its best statically known path/pattern.
#[derive(Debug)]
pub struct PathCandidate {
    /// Word after quote removal and known expansion.
    pub text: String,
    /// None when expansion or the effective directory is unknown.
    pub path: Option<PathBuf>,
    /// Whether shell wildcard expansion can occur.
    pub glob: bool,
}
impl PathCandidate {
    /// Whether this path/pattern can access the root or a descendant. No walk.
    pub fn could_access(&self, root: &Path) -> bool {
        self.path.as_deref().is_some_and(|path| {
            if self.glob {
                glob::overlaps(path, root)
            } else {
                crate::secure_fs::path_is_within(path, root)
            }
        })
    }
}

/// A screening result. Absence of a protected candidate is not authorization.
#[derive(Debug, Default)]
pub struct PathScreen {
    /// Candidate paths, including command names as in the existing guard.
    pub candidates: Vec<PathCandidate>,
    /// False for scripts, substitutions, assignments and unknown directories.
    pub complete: bool,
}

/// Resolve paths in the native shell, including explicitly wrapped cmd scripts.
pub fn screen_paths(command: &str, cwd: &Path, env: &HashMap<String, String>) -> PathScreen {
    let syntax = if super::POSIX_SHELL {
        PathSyntax::Posix
    } else if command
        .trim_start()
        .to_ascii_lowercase()
        .starts_with("cmd ")
        || command
            .trim_start()
            .to_ascii_lowercase()
            .starts_with("cmd.exe ")
    {
        PathSyntax::Cmd
    } else {
        PathSyntax::PowerShell
    };
    screen_paths_with(super::shell::path_script(command), cwd, env, syntax)
}

/// Partially evaluate shell words and directory changes using exactly `env`.
pub fn screen_paths_with(
    command: &str,
    cwd: &Path,
    env: &HashMap<String, String>,
    syntax: PathSyntax,
) -> PathScreen {
    let mut result = PathScreen {
        complete: true,
        ..Default::default()
    };
    let mut directory = Some(cwd.to_path_buf());
    let mut stack = Vec::new();
    for segment in words::segments(command, syntax) {
        let tokens = words::expand(&segment, env, syntax);
        result.complete &= tokens.iter().all(|word| word.known);
        let name = tokens
            .first()
            .map(|word| word.text.to_ascii_lowercase())
            .unwrap_or_default();
        let opaque = opaque(&name, &tokens);
        if opaque {
            result.complete = false;
        }
        let candidates: Vec<_> = tokens
            .iter()
            .map(|word| PathCandidate {
                path: word
                    .known
                    .then(|| resolve(&word.text, directory.as_deref()))
                    .flatten(),
                text: word.text.clone(),
                glob: word.glob,
            })
            .collect();
        change_directory(
            &name,
            &tokens,
            &candidates,
            &mut directory,
            &mut stack,
            expansion::home(env, syntax),
        );
        if opaque {
            directory = None;
        }
        result.complete &= directory.is_some();
        result.candidates.extend(candidates);
    }
    result
}

fn opaque(name: &str, tokens: &[words::Word]) -> bool {
    tokens.iter().any(|word| word.text.contains('='))
        || [
            "eval",
            "source",
            ".",
            "sh",
            "bash",
            "zsh",
            "pwsh",
            "powershell",
            "python",
            "python3",
            "node",
            "bun",
            "ruby",
            "perl",
            "cmd",
            "invoke-expression",
            "iex",
        ]
        .contains(&name)
        || [".sh", ".ps1", ".cmd", ".bat"]
            .iter()
            .any(|suffix| name.ends_with(suffix))
}

fn change_directory(
    name: &str,
    tokens: &[words::Word],
    candidates: &[PathCandidate],
    directory: &mut Option<PathBuf>,
    stack: &mut Vec<Option<PathBuf>>,
    home: Option<&str>,
) {
    if name == "popd" {
        *directory = stack.pop().flatten();
        return;
    }
    if !["cd", "chdir", "pushd", "set-location", "sl"].contains(&name) {
        return;
    }
    let target = tokens
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, word)| !word.text.starts_with('-') && !word.text.eq_ignore_ascii_case("/d"))
        .and_then(|(index, _)| candidates.get(index))
        .filter(|candidate| !candidate.glob)
        .and_then(|candidate| candidate.path.clone());
    if name == "pushd" {
        stack.push(directory.clone());
    }
    *directory = target.or_else(|| {
        (tokens.len() == 1)
            .then(|| home.map(PathBuf::from))
            .flatten()
    });
}

/// Expand and resolve one token used by a lexical guard's existing candidates.
pub fn resolve_path_token(
    token: &str,
    cwd: &Path,
    env: &HashMap<String, String>,
) -> Option<PathBuf> {
    let syntax = if super::POSIX_SHELL {
        PathSyntax::Posix
    } else {
        PathSyntax::PowerShell
    };
    let word = words::token(token, env, syntax)?;
    if !word.known {
        return None;
    }
    resolve(&word.text, Some(cwd))
}

/// Resolve a normalized word. Unknown cwd never becomes the original cwd.
fn resolve(candidate: &str, cwd: Option<&Path>) -> Option<PathBuf> {
    let path = Path::new(candidate);
    let path = if path.is_absolute() || candidate.as_bytes().get(1..3) == Some(b":/") {
        path.to_path_buf()
    } else {
        cwd?.join(path)
    };
    Some(lexical(&path))
}

/// Normalize dot components without filesystem access.
pub fn lexical(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}
