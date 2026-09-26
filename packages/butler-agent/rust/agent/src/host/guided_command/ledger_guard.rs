//! Source run_command Project Ledger command guard. This is lexical command
//! screening before the registered process owner, not a shell interpreter.

mod trust;

use crate::public_text::fixed_regex::fixed_regex;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};

static WRITE_HINT: LazyLock<Regex> = LazyLock::new(|| {
    fixed_regex(
        r#"(?s)(?:^|[\s;&|])(?:cat|printf|echo)\b.*>{1,2}\s*|(?:^|[\s;&|])tee(?:\s+-a)?\s+|(?:^|[\s;&|])(?:touch|mkdir|rm|mv|cp|truncate|install|rsync)\b|(?:^|[\s;&|])dd\b[^;&|]*\bof=|(?:^|[\s;&|])(?:sed|perl)\s+-i\b|(?:^|[\s;&|])find\b.*\s-delete(?:\s|$)|\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|write_text|rmSync|unlinkSync|rmdirSync|renameSync|copyFileSync|cpSync|mkdirSync)\b|\bopen\s*\([^)]*,\s*['"][wax]"#,
    )
});
static REDIRECT: LazyLock<Regex> =
    LazyLock::new(|| fixed_regex(r"(?:^|[\s;&|])(?:\d?>{1,2}|&>)\s*([^\s;&|]+)"));
static TEE: LazyLock<Regex> =
    LazyLock::new(|| fixed_regex(r"(?:^|[\s;&|])tee(?:\s+-a)?\s+([^\s;&|]+)"));
static FILE_OP: LazyLock<Regex> = LazyLock::new(|| {
    fixed_regex(
        r"(?:^|[\s;&|])(?:touch|mkdir|rm|mv|cp|truncate|install|rsync)\b([^;&|]*)|(?:^|[\s;&|])(?:sed|perl)\s+-i\b([^;&|]*)",
    )
});
static DD: LazyLock<Regex> =
    LazyLock::new(|| fixed_regex(r"(?:^|[\s;&|])dd\b[^;&|]*\bof=([^\s;&|]+)"));
static MENTION: LazyLock<Regex> = LazyLock::new(|| {
    fixed_regex(
        r#"(?:^|[\s"'])(\.project-ledger(?:/[^\s"';&|)]*)?|(?:\$BUTLER_DATA|\$\{BUTLER_DATA\}|~/\.butler)/project-ledger/projects(?:/[^\s"';&|)]*)?|(?:\$HOME|\$\{HOME\})/\.butler/project-ledger/projects(?:/[^\s"';&|)]*)?|/[^\s"']*/project-ledger/projects(?:/[^\s"';&|)]*)?)"#,
    )
});
static QUOTED: LazyLock<Regex> = LazyLock::new(|| {
    fixed_regex(
        r#"["']([^"']*(?:\.project-ledger|project-ledger/projects|\.butler/project-ledger)[^"']*)["']"#,
    )
});
static OPAQUE: LazyLock<Regex> = LazyLock::new(|| {
    fixed_regex(
        r"\b(?:node|bun)\s+(?:-e|--eval)\b|\bpython3?\s+-c\b|\bruby\s+-e\b|\bperl\s+-e\b|\bphp\s+-r\b|\beval\b|base64\s+-d|Buffer\.from|atob\s*\(",
    )
});
static ENCODED: LazyLock<Regex> = LazyLock::new(|| {
    fixed_regex(
        r"\beval\b|\bexec\s*\(|\bcompile\s*\(|base64\b|b64decode|fromhex|codecs\.decode|marshal\b|pickle\b|Buffer\.from|atob\s*\(",
    )
});
static RISK: LazyLock<Regex> = LazyLock::new(|| {
    fixed_regex(
        r"project.?ledger|\.project|\.butler|BUTLER_DATA|HOME|process|cwd|String\.fromCharCode|Buffer\.from|spawn|child_process",
    )
});
static ASYNC: LazyLock<Regex> = LazyLock::new(|| {
    fixed_regex(
        r"\b(?:detached|nohup|setsid|disown|setTimeout|spawn|fork|subprocess|Popen|daemon|start_new_session|multiprocessing)\b|os\.fork",
    )
});

pub(super) fn guard(
    command: &str,
    cwd: &Path,
    workspace: &Path,
    data: &Path,
    installation_root: Option<&Path>,
    home: Option<&Path>,
) -> Option<Value> {
    let trusted = trust::is_trusted(command, cwd, installation_root);
    let fallback = [
        ".project-ledger",
        "/project-ledger/projects",
        "$HOME/.butler/project-ledger/projects",
    ];
    if !trusted
        && trust::looks_like_cli(command)
        && let Some(value) = first_protected(fallback, cwd, workspace, data, home)
    {
        return Some(value);
    }
    if !trusted
        && (ASYNC.is_match(command) || has_background(command))
        && let Some(value) = first_protected(fallback, cwd, workspace, data, home)
    {
        return Some(value);
    }
    let write = write_candidates(command);
    if let Some(value) =
        first_protected(write.iter().map(String::as_str), cwd, workspace, data, home)
    {
        return Some(value);
    }
    if !trusted
        && OPAQUE.is_match(command)
        && (ENCODED.is_match(command) || RISK.is_match(command))
        && let Some(value) = first_protected(fallback, cwd, workspace, data, home)
    {
        return Some(value);
    }
    if !trusted {
        let mut mentions = write;
        mentions.extend(
            MENTION
                .captures_iter(command)
                .filter_map(|match_| match_.get(1).map(|m| m.as_str().to_owned())),
        );
        if let Some(value) = first_protected(
            mentions.iter().map(String::as_str),
            cwd,
            workspace,
            data,
            home,
        ) {
            return Some(value);
        }
    }
    None
}

fn write_candidates(command: &str) -> Vec<String> {
    if !WRITE_HINT.is_match(command) {
        return Vec::new();
    }
    let mut result = Vec::new();
    for captures in REDIRECT
        .captures_iter(command)
        .chain(TEE.captures_iter(command))
        .chain(DD.captures_iter(command))
    {
        if let Some(value) = captures.get(1) {
            result.push(value.as_str().into());
        }
    }
    for captures in FILE_OP.captures_iter(command) {
        if let Some(part) = captures.get(1).or_else(|| captures.get(2)) {
            result.extend(
                part.as_str()
                    .split_whitespace()
                    .filter(|word| !word.starts_with('-'))
                    .map(str::to_owned),
            );
        }
    }
    result.extend(
        QUOTED
            .captures_iter(command)
            .filter_map(|c| c.get(1).map(|v| v.as_str().to_owned())),
    );
    if (command.contains("writeFile")
        || command.contains("appendFile")
        || command.contains("createWriteStream"))
        && ASYNC.is_match(command)
    {
        if command.contains("process.cwd()") {
            result.push(".project-ledger".into());
        }
        if command.contains("process.env.BUTLER_DATA") {
            result.push("/project-ledger/projects".into());
        }
        if command.contains("process.env.HOME") {
            result.push("$HOME/.butler/project-ledger/projects".into());
        }
    }
    result
}

fn first_protected<'a>(
    candidates: impl IntoIterator<Item = &'a str>,
    cwd: &Path,
    workspace: &Path,
    data: &Path,
    home: Option<&Path>,
) -> Option<Value> {
    for raw in candidates {
        let candidate = raw
            .trim()
            .trim_start_matches(['`', '"', '\''])
            .trim_end_matches(['`', '"', '\'', ',', ';', '|', ')']);
        if candidate.is_empty() {
            continue;
        }
        let Some(path) = resolve(candidate, cwd, data, home) else {
            continue;
        };
        if protected(&path, workspace, data, home) {
            return Some(json!({
                "ok":false,"error":"protected_path",
                "message":"Project Ledger source records must be mutated through Project Ledger commands.",
                "protected_path":candidate,
                "next":[{"command":"project-ledger record update --id <id> --from FILE|-"}]
            }));
        }
    }
    None
}

fn resolve(candidate: &str, cwd: &Path, data: &Path, home: Option<&Path>) -> Option<PathBuf> {
    let path = if let Some(suffix) = candidate
        .strip_prefix("$BUTLER_DATA/")
        .or_else(|| candidate.strip_prefix("${BUTLER_DATA}/"))
    {
        data.join(suffix)
    } else if let Some(suffix) = candidate
        .strip_prefix("$HOME/")
        .or_else(|| candidate.strip_prefix("${HOME}/"))
    {
        home?.join(suffix)
    } else if let Some(suffix) = candidate.strip_prefix("~/") {
        home?.join(suffix)
    } else if candidate.starts_with("/project-ledger/projects/") {
        data.join(candidate.trim_start_matches('/'))
    } else if candidate.starts_with("/.project-ledger/") {
        cwd.join(candidate.trim_start_matches('/'))
    } else if Path::new(candidate).is_absolute() {
        PathBuf::from(candidate)
    } else if candidate.starts_with("project-ledger/projects/") {
        data.join(candidate)
    } else {
        cwd.join(candidate)
    };
    Some(lexical(&path))
}

fn protected(path: &Path, workspace: &Path, data: &Path, home: Option<&Path>) -> bool {
    let mut roots = vec![
        workspace.join(".project-ledger"),
        data.join("project-ledger/projects"),
    ];
    if let Some(home) = home {
        roots.push(home.join(".butler/project-ledger/projects"));
    }
    let target = real_or_nearest(path);
    roots
        .into_iter()
        .map(|root| real_or_nearest(&root))
        .any(|root| target.starts_with(root))
}

fn real_or_nearest(path: &Path) -> PathBuf {
    let mut current = lexical(path);
    let mut suffix = Vec::new();
    loop {
        if let Ok(real) = std::fs::canonicalize(&current) {
            return suffix
                .into_iter()
                .rev()
                .fold(real, |path, part| path.join(part));
        }
        let Some(name) = current.file_name().map(std::borrow::ToOwned::to_owned) else {
            return lexical(path);
        };
        suffix.push(name);
        if !current.pop() {
            return lexical(path);
        }
    }
}

fn lexical(path: &Path) -> PathBuf {
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

fn has_background(command: &str) -> bool {
    if command.as_bytes().last() == Some(&b'&')
        && !command
            .as_bytes()
            .get(command.len().saturating_sub(2))
            .is_some_and(|ch| matches!(ch, b'&' | b'>'))
    {
        return true;
    }
    command
        .as_bytes()
        .windows(2)
        .enumerate()
        .any(|(index, pair)| {
            pair[0] == b'&'
                && pair[1] != b'&'
                && pair[1] != b'>'
                && (index == 0 || !matches!(command.as_bytes()[index - 1], b'&' | b'>'))
        })
}
