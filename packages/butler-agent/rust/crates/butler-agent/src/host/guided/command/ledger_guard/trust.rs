use std::path::{Path, PathBuf};

pub(super) fn is_trusted(command: &str, cwd: &Path, installation_root: Option<&Path>) -> bool {
    let tokens = tokens(command);
    if tokens.is_empty() || command.chars().any(|ch| ";&|<>`$()".contains(ch)) {
        return false;
    }
    if assignment(&tokens[0]) {
        return false;
    }
    let candidate = if node(&tokens[0]) {
        let Some(value) = tokens.get(1) else {
            return false;
        };
        if value.starts_with('-') {
            return false;
        }
        value
    } else {
        &tokens[0]
    };
    if !cli_path(candidate) {
        return false;
    }
    let path = Path::new(candidate);
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    };
    let Some(real) = std::fs::canonicalize(path).ok() else {
        return false;
    };
    trusted_roots(installation_root)
        .into_iter()
        .flat_map(|root| {
            [
                root.join("packages/project-ledger/bin/project-ledger"),
                root.join("packages/project-ledger/bin/pl"),
            ]
        })
        .filter_map(|path| std::fs::canonicalize(path).ok())
        .any(|allowed| allowed == real)
}

pub(super) fn looks_like_cli(command: &str) -> bool {
    let tokens = tokens(command);
    let mut index = 0;
    while tokens.get(index).is_some_and(|token| assignment(token)) {
        index += 1;
    }
    let Some(first) = tokens.get(index) else {
        return false;
    };
    first == "project-ledger"
        || first == "pl"
        || if node(first) {
            tokens[index + 1..].iter().any(|token| cli_path(token))
        } else {
            cli_path(first)
        }
}

fn trusted_roots(installation_root: Option<&Path>) -> Vec<PathBuf> {
    installation_root
        .into_iter()
        .map(Path::to_path_buf)
        .collect()
}

fn cli_path(token: &str) -> bool {
    let token = token.replace('\\', "/");
    token == "packages/project-ledger/bin/project-ledger"
        || token == "packages/project-ledger/bin/pl"
        || token.ends_with("/packages/project-ledger/bin/project-ledger")
        || token.ends_with("/packages/project-ledger/bin/pl")
}
fn node(token: &str) -> bool {
    token == "node"
}
fn assignment(token: &str) -> bool {
    let Some((name, _)) = token.split_once('=') else {
        return false;
    };
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|ch| ch.is_ascii_uppercase() || ch == '_')
        && chars.all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_')
}
fn tokens(command: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut token = String::new();
    let mut quote = None;
    for ch in command.chars() {
        if let Some(expected) = quote {
            if ch == expected {
                quote = None;
            } else {
                token.push(ch);
            }
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            continue;
        }
        if ch.is_whitespace() {
            if !token.is_empty() {
                result.push(std::mem::take(&mut token));
            }
        } else {
            token.push(ch);
        }
    }
    if !token.is_empty() {
        result.push(token);
    }
    result
}
