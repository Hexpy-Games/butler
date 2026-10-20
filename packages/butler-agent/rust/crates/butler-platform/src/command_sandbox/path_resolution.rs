//! Partial shell interpretation for lexical guards. Incomplete means unknown,
//! never safe: arbitrary programs require kernel credential-read protection.
mod comparison;
mod expansion;
mod glob;
mod links;
mod location;
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
    /// POSIX wildcard components require an explicit leading dot.
    pub posix_glob: bool,
}
impl PathCandidate {
    /// Whether recursive access can reach a credential root, including ancestors.
    pub fn could_reach(&self, root: &Path) -> bool {
        self.path.as_deref().is_some_and(|path| {
            if self.glob {
                glob::overlaps_ancestor(path, root, self.posix_glob)
            } else {
                comparison::within(path, root) || comparison::within(root, path)
            }
        })
    }

    /// Whether this path/pattern can access the root or a descendant. No walk.
    pub fn could_access(&self, root: &Path) -> bool {
        self.path.as_deref().is_some_and(|path| {
            if self.glob {
                glob::overlaps(path, root, self.posix_glob)
            } else {
                comparison::within(path, root)
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
    /// First word whose path or execution context could not be established.
    pub unknown: Option<String>,
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
    let mut directories = location::Directories::new(cwd);
    let mut filesystem_stable = true;
    let segments: Vec<_> = words::segments(command, syntax)
        .into_iter()
        .map(|segment| {
            let mut tokens = words::expand(&segment.text, env, syntax);
            let unknown_location = location::expand_attached(&mut tokens, syntax);
            words::normalize(&mut tokens, syntax);
            (segment, tokens, unknown_location)
        })
        .collect();
    // Pipelines and background jobs run concurrently: text order gives no
    // filesystem ordering. Link-producing operations affect the whole script.
    let links_possible = segments.iter().any(|(_, tokens, _)| links::creates(tokens));
    for (segment, tokens, unknown_location) in segments {
        result.complete &= tokens.iter().all(|word| word.known);
        let name = command_name(&tokens);
        let opaque =
            unknown_location || opaque(&name, &tokens) || tokens.iter().any(|word| !word.known);
        if opaque {
            result.complete = false;
        }
        let mut candidates = candidates(
            &tokens,
            directories.current.as_deref(),
            filesystem_stable,
            links_possible,
            syntax,
        );
        links::targets(&tokens, &mut candidates);
        let location = directories.change(
            &name,
            &tokens,
            &candidates,
            expansion::home(env, syntax),
            segment.carries_directory(),
            syntax,
        );
        filesystem_stable &= location;
        result.complete &= directories.current.is_some();
        let index = usize::from(!opaque && segment.carries_directory() && tokens.len() > 1);
        let fallback = tokens
            .get(index)
            .map_or(segment.text.as_str(), |word| &word.text);
        record_candidates(&mut result, candidates, &tokens, fallback);
        if !result.complete {
            directories.invalidate();
        }
    }
    result
}

fn record_candidates(
    result: &mut PathScreen,
    candidates: Vec<PathCandidate>,
    tokens: &[words::Word],
    fallback: &str,
) {
    let unknown = tokens
        .iter()
        .zip(&candidates)
        .find(|(word, path)| !word.known || word.path && path.path.is_none())
        .map(|(word, _)| word.text.clone());
    result.complete &= unknown.is_none();
    if !result.complete && result.unknown.is_none() {
        result.unknown = Some(unknown.unwrap_or_else(|| fallback.to_owned()));
    }
    result.candidates.extend(
        candidates
            .into_iter()
            .zip(tokens)
            .filter_map(|(path, word)| word.path.then_some(path)),
    );
}

fn candidates(
    tokens: &[words::Word],
    cwd: Option<&Path>,
    filesystem_stable: bool,
    links_possible: bool,
    syntax: PathSyntax,
) -> Vec<PathCandidate> {
    tokens
        .iter()
        .map(|word| PathCandidate {
            path: (word.path
                && word.known
                && (filesystem_stable
                    || !Path::new(&word.text)
                        .components()
                        .any(|part| part == Component::ParentDir)))
            .then(|| resolve(&word.text, cwd, !links_possible))
            .flatten(),
            text: word.text.clone(),
            glob: word.glob,
            posix_glob: syntax == PathSyntax::Posix,
        })
        .collect()
}

fn command_name(tokens: &[words::Word]) -> String {
    tokens
        .first()
        .map(|word| {
            word.text
                .to_ascii_lowercase()
                .trim_end_matches(".exe")
                .to_owned()
        })
        .unwrap_or_default()
}

fn opaque(name: &str, tokens: &[words::Word]) -> bool {
    // Executable paths still retain the existing interpreter/script opacity.
    let name = name.rsplit(['/', '\\']).next().unwrap_or_default();
    tokens
        .iter()
        .any(|word| word.path && !word.text.starts_with('-') && word.text.contains('='))
        || [
            "if",
            "then",
            "else",
            "elif",
            "fi",
            "while",
            "until",
            "do",
            "done",
            "for",
            "select",
            "in",
            "case",
            "esac",
            "function",
            "foreach",
            "switch",
            "try",
            "catch",
            "finally",
            "trap",
            "shopt",
            "setopt",
            "unsetopt",
            "enable",
            "extglob",
            "alias",
            "unalias",
            "set",
            "unset",
            "export",
            "declare",
            "typeset",
            "local",
            "nohup",
            "nice",
            "timeout",
            "doas",
            "su",
            "command",
            "builtin",
            "exec",
            "env",
            "sudo",
            "time",
            "coproc",
            "!",
            "{",
            "}",
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
    resolve(&word.text, Some(cwd), true)
}

/// Resolve components in lookup order, before applying each parent traversal.
/// Missing suffixes are useful lexical candidates, but cannot establish a
/// parent: they might be links created by an earlier command in this script.
fn resolve(candidate: &str, cwd: Option<&Path>, allow_missing_parent: bool) -> Option<PathBuf> {
    let path = Path::new(candidate);
    let path = if path.is_absolute() || candidate.as_bytes().get(1..3) == Some(b":/") {
        path.to_path_buf()
    } else {
        cwd?.join(path)
    };
    let mut result = PathBuf::new();
    let mut existing = true;
    let mut parts = path.components().peekable();
    while let Some(part) = parts.next() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                if !existing || !result.is_dir() {
                    return None;
                }
                result.pop();
            }
            other => {
                result.push(other.as_os_str());
                if existing {
                    match crate::secure_fs::canonicalize(&result) {
                        Ok(real) => result = real,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                            if !allow_missing_parent && parts.peek().is_some() {
                                return None;
                            }
                            existing = false;
                        }
                        Err(_) => return None,
                    }
                }
            }
        }
    }
    Some(result)
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
