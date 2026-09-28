//! Which lines of a Rust source or a package manifest are OS-specific.
//!
//! Sources are read as tokens, so comments, documentation and string
//! literals never count.

use std::collections::BTreeSet;

use proc_macro2::{Delimiter, TokenStream, TokenTree};

/// `cfg` predicates that select an operating system.
const OS_PREDICATES: &[&str] = &[
    "unix",
    "windows",
    "target_os",
    "target_family",
    "target_vendor",
    "target_env",
];
/// Attributes and macros whose predicates are checked.
const CONDITIONALS: &[&str] = &["cfg", "cfg_attr"];
/// OS-specific modules of `std::os`.
const OS_MODULES: &[&str] = &[
    "unix", "windows", "fd", "linux", "macos", "darwin", "android", "ios", "freebsd", "wasi",
];
/// Crates that are bindings to one family of operating systems.
const OS_CRATES: &[&str] = &["nix", "libc", "libproc", "rustix"];
/// Environment variables that name the user's home directory.
const HOME_VARIABLES: &[&str] = &["\"HOME\"", "\"USERPROFILE\""];
/// Paths whose `home_dir` reads the home directory.
const HOME_DIR_OWNERS: &[&str] = &["env", "dirs", "home"];

/// The 1-based lines of `contents` with OS-specific code.
pub(super) fn source(contents: &str) -> Result<BTreeSet<usize>, String> {
    let tokens: TokenStream = contents.parse().map_err(|error| format!("{error:?}"))?;
    let mut lines = BTreeSet::new();
    visit(tokens, &mut lines);
    Ok(lines)
}

/// The 1-based lines of a Cargo.toml that declare OS-specific dependencies:
/// `[target.'cfg(..)']` tables that select an OS and OS binding crates.
pub(super) fn manifest(contents: &str) -> BTreeSet<usize> {
    contents
        .lines()
        .enumerate()
        .filter(|(_, line)| {
            let line = line.trim_start();
            (line.starts_with("[target.")
                && OS_PREDICATES
                    .iter()
                    .any(|predicate| line.contains(predicate)))
                || OS_CRATES.iter().any(|name| {
                    line.strip_prefix(name)
                        .is_some_and(|rest| rest.starts_with([' ', '=', '.']))
                })
        })
        .map(|(index, _)| index + 1)
        .collect()
}

fn visit(stream: TokenStream, lines: &mut BTreeSet<usize>) {
    let tokens: Vec<TokenTree> = stream.into_iter().collect();
    for (index, token) in tokens.iter().enumerate() {
        match token {
            TokenTree::Group(group) => visit(group.stream(), lines),
            TokenTree::Literal(literal) if literal.to_string().starts_with("0o") => {
                lines.insert(line(token));
            }
            TokenTree::Ident(_) if os_specific(&tokens, index) => {
                lines.insert(line(token));
            }
            _ => {}
        }
    }
}

/// Whether the identifier at `index` starts OS-specific code.
fn os_specific(tokens: &[TokenTree], index: usize) -> bool {
    let Some(TokenTree::Ident(ident)) = tokens.get(index) else {
        return false;
    };
    let name = ident.to_string();
    let name = name.as_str();
    if CONDITIONALS.contains(&name) {
        return os_condition(tokens, index + 1);
    }
    if name == "os" && path_separator(tokens, index + 1) {
        return tokens
            .get(index + 3)
            .is_some_and(|next| OS_MODULES.contains(&next.to_string().as_str()));
    }
    if OS_CRATES.contains(&name) {
        return path_separator(tokens, index + 1);
    }
    if matches!(name, "var" | "var_os") {
        return home_argument(tokens.get(index + 1));
    }
    if name == "home_dir" {
        return index >= 3
            && path_separator(tokens, index - 2)
            && tokens
                .get(index - 3)
                .is_some_and(|owner| HOME_DIR_OWNERS.contains(&owner.to_string().as_str()));
    }
    false
}

/// Whether the predicate group of a `cfg`, `cfg!` or `cfg_attr` starting at
/// `index` names an operating system.
fn os_condition(tokens: &[TokenTree], mut index: usize) -> bool {
    if matches!(tokens.get(index), Some(TokenTree::Punct(bang)) if bang.as_char() == '!') {
        index += 1;
    }
    match tokens.get(index) {
        Some(TokenTree::Group(group)) if group.delimiter() == Delimiter::Parenthesis => {
            names_os(group.stream())
        }
        _ => false,
    }
}

fn names_os(stream: TokenStream) -> bool {
    stream.into_iter().any(|token| match token {
        TokenTree::Group(group) => names_os(group.stream()),
        TokenTree::Ident(ident) => OS_PREDICATES.contains(&ident.to_string().as_str()),
        _ => false,
    })
}

/// Whether `var(..)`/`var_os(..)` reads a home-directory variable.
fn home_argument(token: Option<&TokenTree>) -> bool {
    let Some(TokenTree::Group(group)) = token else {
        return false;
    };
    group.delimiter() == Delimiter::Parenthesis
        && group
            .stream()
            .into_iter()
            .next()
            .is_some_and(|first| HOME_VARIABLES.contains(&first.to_string().as_str()))
}

/// Whether `tokens[index..]` starts with `::`.
fn path_separator(tokens: &[TokenTree], index: usize) -> bool {
    let colon = |token: Option<&TokenTree>| matches!(token, Some(TokenTree::Punct(punct)) if punct.as_char() == ':');
    colon(tokens.get(index)) && colon(tokens.get(index + 1))
}

fn line(token: &TokenTree) -> usize {
    token.span().start().line
}

#[cfg(test)]
mod tests {
    use super::{manifest, source};

    fn lines(contents: &str) -> Vec<usize> {
        source(contents).unwrap().into_iter().collect()
    }

    #[test]
    fn flags_os_selection_apis_modes_and_home_reads() {
        let contents = "\
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg_attr(target_os = \"macos\", expect(dead_code))]
fn a() { if cfg!(windows) {} }
#[cfg(all(test, not(target_family = \"wasm\")))]
use std::{io, os::fd::AsRawFd};
fn b() { nix::unistd::getpid(); let _ = libc::O_NOFOLLOW; }
fn c() { set(0o600); }
fn d() { std::env::var_os(\"HOME\"); env::var(\"USERPROFILE\"); std::env::home_dir(); }
";
        assert_eq!(lines(contents), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    }

    #[test]
    fn ignores_comments_strings_and_neutral_code() {
        let contents = "\
// #[cfg(unix)] std::os::unix nix::errno 0o600 var_os(\"HOME\")
/// Uses `std::os::unix` and `cfg(windows)`.
#[cfg(test)]
#[cfg(any(test, feature = \"test-support\"))]
fn a() { let text = \"#[cfg(unix)] 0o600\"; bytes.windows(2); }
fn b() { env::var(\"PATH\"); user_dirs::home_dir(); let unix = 1; let mode = 0x600; }
use std::os::raw::c_int;
";
        assert!(lines(contents).is_empty());
    }

    #[test]
    fn manifests_flag_os_tables_and_binding_crates() {
        let contents = "\
[dependencies]
serde.workspace = true
[target.'cfg(unix)'.dependencies]
nix.workspace = true
rustix = { workspace = true }
[target.'cfg(target_os = \"macos\")'.dependencies]
libproc.workspace = true
[target.'cfg(feature = \"x\")'.dependencies]
nixie = \"1\"
";
        assert_eq!(
            manifest(contents).into_iter().collect::<Vec<_>>(),
            [3, 4, 5, 6, 7]
        );
    }
}
