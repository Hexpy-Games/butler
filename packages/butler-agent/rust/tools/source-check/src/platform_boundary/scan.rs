//! Which constructs of a Rust source or a package manifest are OS-specific.
//!
//! Sources are read as tokens, so comments, documentation and string
//! literals never count. Manifests are parsed as TOML, so every spelling of a
//! dependency or a target table is seen.

use std::collections::BTreeMap;

use proc_macro2::{Delimiter, TokenStream, TokenTree};
use toml::de::{DeTable, DeValue};

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
/// Constants of `std::env::consts` that name the operating system.
const OS_CONSTANTS: &[&str] = &["OS", "FAMILY"];
/// Manifest tables that declare dependencies.
const DEPENDENCY_TABLES: &[&str] = &[
    "dependencies",
    "dev-dependencies",
    "dev_dependencies",
    "build-dependencies",
    "build_dependencies",
];

/// One OS-specific construct: its 1-based line and its compact spelling,
/// which identifies it in the baseline wherever it moves.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Finding {
    pub(super) line: usize,
    pub(super) code: String,
}

/// The OS-specific constructs of a Rust source, in order.
pub(super) fn source(contents: &str) -> Result<Vec<Finding>, String> {
    let tokens: TokenStream = contents.parse().map_err(|error| format!("{error:?}"))?;
    let mut found = Vec::new();
    visit(tokens, false, &mut found);
    found.sort_by_key(|finding| finding.line);
    Ok(found)
}

/// The dependency keys of `[workspace.dependencies]` mapped to the package
/// each names, so `x.workspace = true` resolves a renamed crate.
pub(super) fn workspace_packages(contents: &str) -> Result<BTreeMap<String, String>, String> {
    let document = DeTable::parse(contents).map_err(|error| error.to_string())?;
    let mut packages = BTreeMap::new();
    let dependencies = document
        .get_ref()
        .get("workspace")
        .and_then(|workspace| workspace.get_ref().get("dependencies"))
        .and_then(|dependencies| dependencies.get_ref().as_table());
    for (key, value) in dependencies.into_iter().flatten() {
        let key = key.get_ref().to_string();
        let package = package_field(value.get_ref())
            .unwrap_or(key.as_str())
            .to_owned();
        packages.insert(key, package);
    }
    Ok(packages)
}

/// The OS-specific declarations of a package manifest: target tables that
/// select an operating system (a target triple always does) and every
/// dependency on an OS binding crate, however it is spelled or renamed.
pub(super) fn manifest(
    contents: &str,
    workspace: &BTreeMap<String, String>,
) -> Result<Vec<Finding>, String> {
    let document = DeTable::parse(contents).map_err(|error| error.to_string())?;
    let root = document.get_ref();
    let mut found = Vec::new();
    dependencies(contents, root, workspace, &mut found);
    let targets = root
        .get("target")
        .and_then(|value| value.get_ref().as_table());
    for (key, value) in targets.into_iter().flatten() {
        let target = key.get_ref();
        if os_target(target) {
            found.push(Finding {
                line: line_at(contents, key.span().start),
                code: format!("[target.'{target}']"),
            });
        }
        if let Some(table) = value.get_ref().as_table() {
            dependencies(contents, table, workspace, &mut found);
        }
    }
    found.sort_by_key(|finding| finding.line);
    Ok(found)
}

fn dependencies(
    contents: &str,
    table: &DeTable<'_>,
    workspace: &BTreeMap<String, String>,
    found: &mut Vec<Finding>,
) {
    for section in DEPENDENCY_TABLES {
        let entries = table
            .get(*section)
            .and_then(|value| value.get_ref().as_table());
        for (key, value) in entries.into_iter().flatten() {
            let name: &str = key.get_ref();
            let inherited = value
                .get_ref()
                .get("workspace")
                .and_then(|flag| flag.get_ref().as_bool())
                == Some(true);
            let package = package_field(value.get_ref())
                .or_else(|| {
                    inherited
                        .then(|| workspace.get(name))
                        .flatten()
                        .map(String::as_str)
                })
                .unwrap_or(name);
            if OS_CRATES.contains(&package) {
                found.push(Finding {
                    line: line_at(contents, key.span().start),
                    code: if package == name {
                        format!("dependency {name}")
                    } else {
                        format!("dependency {name} = {package}")
                    },
                });
            }
        }
    }
}

fn package_field<'a>(value: &'a DeValue<'_>) -> Option<&'a str> {
    value
        .get("package")
        .and_then(|package| package.get_ref().as_str())
}

/// Whether a `[target.<key>]` table selects an operating system: a `cfg(..)`
/// that names one, or a target triple.
fn os_target(key: &str) -> bool {
    match key.strip_prefix("cfg") {
        Some(predicate) => predicate.parse::<TokenStream>().is_ok_and(names_os),
        None => true,
    }
}

fn line_at(contents: &str, offset: usize) -> usize {
    contents
        .get(..offset)
        .map_or(0, |before| before.matches('\n').count())
        + 1
}

/// Visits `stream`; `import` when it is the `{..}` list of a `use`.
fn visit(stream: TokenStream, import: bool, found: &mut Vec<Finding>) {
    let tokens: Vec<TokenTree> = stream.into_iter().collect();
    let mut index = 0;
    while let Some(token) = tokens.get(index) {
        if let Some(end) = os_specific(&tokens, index, import) {
            found.push(Finding {
                line: token.span().start().line,
                code: render(tokens.get(index..end).unwrap_or_default()),
            });
            index = end;
            continue;
        }
        if let TokenTree::Group(group) = token {
            let list = group.delimiter() == Delimiter::Brace
                && ((index >= 2 && path_separator(&tokens, index - 2))
                    || (index >= 1 && ident_at(&tokens, index - 1, "use")));
            visit(group.stream(), list, found);
        }
        index += 1;
    }
}

/// Where the OS-specific construct starting at `index` ends (exclusive), if
/// one starts there.
fn os_specific(tokens: &[TokenTree], index: usize, import: bool) -> Option<usize> {
    let token = tokens.get(index)?;
    if let TokenTree::Literal(literal) = token {
        return literal.to_string().starts_with("0o").then_some(index + 1);
    }
    let TokenTree::Ident(ident) = token else {
        return None;
    };
    let name = ident.to_string();
    let name = name.as_str();
    if CONDITIONALS.contains(&name) {
        return os_condition(tokens, index + 1);
    }
    if name == "os" {
        return os_module(tokens, index, import);
    }
    if OS_CRATES.contains(&name) {
        let external = index >= 2
            && ident_at(tokens, index - 1, "crate")
            && ident_at(tokens, index - 2, "extern");
        return (path_separator(tokens, index + 1)
            || ident_at(tokens, index + 1, "as")
            || external)
            .then(|| path_end(tokens, index));
    }
    if matches!(name, "var" | "var_os") {
        return home_argument(tokens.get(index + 1)).then_some(index + 2);
    }
    if HOME_DIR_OWNERS.contains(&name) && path_separator(tokens, index + 1) {
        return ident_at(tokens, index + 3, "home_dir").then_some(index + 4);
    }
    if name == "consts" {
        return os_constant(tokens, index);
    }
    None
}

/// `os::<os module>`, `os::{<os module>::..}` and a rename of `std::os`.
fn os_module(tokens: &[TokenTree], index: usize, import: bool) -> Option<usize> {
    if path_separator(tokens, index + 1) {
        let reaches_os = match tokens.get(index + 3)? {
            TokenTree::Ident(module) => OS_MODULES.contains(&module.to_string().as_str()),
            TokenTree::Group(group) if group.delimiter() == Delimiter::Brace => {
                imports_any(group.stream(), OS_MODULES)
            }
            _ => false,
        };
        return reaches_os.then(|| path_end(tokens, index));
    }
    // `std::os as o` or `std::{os as o}`; `os as u32` in an expression is a cast.
    let in_path = index >= 2 && path_separator(tokens, index - 2);
    let in_import = import
        && (index == 0
            || matches!(tokens.get(index - 1), Some(TokenTree::Punct(p)) if p.as_char() == ','));
    (ident_at(tokens, index + 1, "as") && (in_path || in_import)).then_some(index + 3)
}

/// `consts::OS`, `consts::FAMILY`, `consts::*`, `consts::{OS, ..}` and a
/// rename of `consts`.
fn os_constant(tokens: &[TokenTree], index: usize) -> Option<usize> {
    if ident_at(tokens, index + 1, "as") {
        return Some(index + 3);
    }
    if !path_separator(tokens, index + 1) {
        return None;
    }
    let names_os = match tokens.get(index + 3)? {
        TokenTree::Ident(constant) => OS_CONSTANTS.contains(&constant.to_string().as_str()),
        TokenTree::Punct(glob) => glob.as_char() == '*',
        TokenTree::Group(group) if group.delimiter() == Delimiter::Brace => {
            imports_any(group.stream(), OS_CONSTANTS)
        }
        _ => false,
    };
    names_os.then_some(index + 4)
}

/// Whether a `{..}` import list names one of `names` as a path start.
fn imports_any(stream: TokenStream, names: &[&str]) -> bool {
    let tokens: Vec<TokenTree> = stream.into_iter().collect();
    tokens.iter().enumerate().any(|(index, token)| {
        let starts = index == 0
            || matches!(tokens.get(index - 1), Some(TokenTree::Punct(p)) if p.as_char() == ',');
        starts && names.contains(&token.to_string().as_str())
    })
}

/// Where the path starting at the identifier `index` ends (exclusive):
/// through every `::segment`, a final `{..}` list or `*`, and an `as alias`.
fn path_end(tokens: &[TokenTree], index: usize) -> usize {
    let mut end = index + 1;
    while path_separator(tokens, end) {
        match tokens.get(end + 2) {
            Some(TokenTree::Ident(_)) => end += 3,
            Some(TokenTree::Group(group)) if group.delimiter() == Delimiter::Brace => {
                end += 3;
                break;
            }
            Some(TokenTree::Punct(glob)) if glob.as_char() == '*' => {
                end += 3;
                break;
            }
            _ => break,
        }
    }
    if ident_at(tokens, end, "as") && matches!(tokens.get(end + 1), Some(TokenTree::Ident(_))) {
        end += 2;
    }
    end
}

/// Whether the predicate group of a `cfg`, `cfg!` or `cfg_attr` starting at
/// `index` names an operating system; where the construct ends if so.
fn os_condition(tokens: &[TokenTree], mut index: usize) -> Option<usize> {
    if matches!(tokens.get(index), Some(TokenTree::Punct(bang)) if bang.as_char() == '!') {
        index += 1;
    }
    match tokens.get(index) {
        Some(TokenTree::Group(group))
            if group.delimiter() == Delimiter::Parenthesis && names_os(group.stream()) =>
        {
            Some(index + 1)
        }
        _ => None,
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

fn ident_at(tokens: &[TokenTree], index: usize, name: &str) -> bool {
    matches!(tokens.get(index), Some(TokenTree::Ident(ident)) if ident == name)
}

/// Whether `tokens[index..]` starts with `::`.
fn path_separator(tokens: &[TokenTree], index: usize) -> bool {
    let colon = |token: Option<&TokenTree>| matches!(token, Some(TokenTree::Punct(punct)) if punct.as_char() == ':');
    colon(tokens.get(index)) && colon(tokens.get(index + 1))
}

/// `tokens` without layout: a space only between two words.
fn render(tokens: &[TokenTree]) -> String {
    let mut text = String::new();
    let mut word = false;
    for token in tokens {
        match token {
            TokenTree::Group(group) => {
                let (open, close) = match group.delimiter() {
                    Delimiter::Parenthesis => ("(", ")"),
                    Delimiter::Brace => ("{", "}"),
                    Delimiter::Bracket => ("[", "]"),
                    Delimiter::None => ("", ""),
                };
                let inner: Vec<TokenTree> = group.stream().into_iter().collect();
                text.push_str(open);
                text.push_str(&render(&inner));
                text.push_str(close);
                word = false;
            }
            TokenTree::Punct(punct) => {
                text.push(punct.as_char());
                word = false;
            }
            TokenTree::Ident(_) | TokenTree::Literal(_) => {
                if word {
                    text.push(' ');
                }
                text.push_str(&token.to_string());
                word = true;
            }
        }
    }
    text
}

#[cfg(test)]
mod tests;
