//! Secrets written straight into a command line or URL. Such servers are
//! left for the user to set up; the secret is never copied.

/// Flag words that carry a credential as their value.
const SECRET_FLAGS: [&str; 9] = [
    "token",
    "secret",
    "password",
    "passwd",
    "api-key",
    "api_key",
    "apikey",
    "access-key",
    "auth",
];

/// Well-known credential prefixes.
const TOKEN_PREFIXES: [&str; 10] = [
    "ghp_",
    "gho_",
    "ghs_",
    "github_pat_",
    "glpat-",
    "sk-",
    "xoxb-",
    "xoxp-",
    "akia",
    "bearer ",
];

fn secret_flag(flag: &str) -> bool {
    let word = flag.trim_start_matches('-').to_ascii_lowercase();
    flag.starts_with('-') && SECRET_FLAGS.iter().any(|secret| word.contains(secret))
}

fn looks_like_token(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    TOKEN_PREFIXES
        .iter()
        .any(|prefix| lower.starts_with(prefix))
        || lower.contains("bearer ")
        || lower.starts_with("authorization:")
        || (lower.contains("://") && !url_is_clean(value))
}

/// A credential appears in the arguments (`--token x`, `--api-key=x`, `ghp_…`).
pub(super) fn in_arguments(args: &[String]) -> bool {
    let mut value_follows = false;
    for arg in args {
        if value_follows {
            return true;
        }
        let (flag, value) = match arg.split_once('=') {
            Some((flag, value)) => (flag, Some(value)),
            None => (arg.as_str(), None),
        };
        if secret_flag(flag) {
            match value {
                Some(value) if !value.is_empty() => return true,
                _ => value_follows = true,
            }
        } else if looks_like_token(arg) || value.is_some_and(looks_like_token) {
            return true;
        }
    }
    false
}

/// No user name, password or credential-like query parameter.
pub(super) fn url_is_clean(raw: &str) -> bool {
    let Ok(url) = url::Url::parse(raw.trim()) else {
        return false;
    };
    url.username().is_empty()
        && url.password().is_none()
        && url.query_pairs().all(|(key, value)| {
            let key = key.to_ascii_lowercase();
            !(SECRET_FLAGS.iter().any(|secret| key.contains(secret))
                || key == "key"
                || key == "sig"
                || looks_like_prefix(&value))
        })
}

fn looks_like_prefix(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    TOKEN_PREFIXES
        .iter()
        .any(|prefix| lower.starts_with(prefix))
}
