use std::{
    fs,
    path::{Path, PathBuf},
};

use regex::{Regex, RegexBuilder};

/// Call sites whose pattern is composed from source constants rather than a
/// single literal. Each entry names the test that constructs those patterns.
const COMPOSED: &[(&str, &str)] = &[
    (
        "public_text/patterns.rs",
        "public_text::tests (every sanitize call forces Patterns::new)",
    ),
    (
        "work_records/dashboard/evidence.rs",
        "literal arguments of matches_fixed() are compiled below",
    ),
];

/// Helpers whose first argument is a fixed pattern literal.
const HELPERS: &[(&str, bool)] = &[
    ("fixed_regex(", false),
    ("fixed_regex_ci(", true),
    ("matches_fixed(", false),
];

fn rust_files(root: &Path, files: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, files);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            files.push(path);
        }
    }
}

/// Parses a Rust string literal at the start of `text` (after whitespace).
fn leading_literal(text: &str) -> Option<String> {
    let text = text.trim_start();
    if let Some(raw) = text.strip_prefix('r') {
        let hashes = raw
            .chars()
            .take_while(|character| *character == '#')
            .count();
        let body = raw[hashes..].strip_prefix('"')?;
        let terminator = format!("\"{}", "#".repeat(hashes));
        let end = body.find(&terminator)?;
        return Some(body[..end].to_owned());
    }
    let body = text.strip_prefix('"')?;
    let mut value = String::new();
    let mut characters = body.chars();
    while let Some(character) = characters.next() {
        match character {
            '"' => return Some(value),
            '\\' => match characters.next()? {
                'n' => value.push('\n'),
                't' => value.push('\t'),
                '\\' => value.push('\\'),
                '"' => value.push('"'),
                other => panic!("unsupported escape \\{other} in fixed regex literal"),
            },
            other => value.push(other),
        }
    }
    None
}

#[test]
fn every_fixed_pattern_compiles() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&root, &mut files);
    let mut compiled = 0;
    for file in files {
        let relative = file
            .strip_prefix(&root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if relative.starts_with("public_text/source_regex") {
            continue;
        }
        let source = fs::read_to_string(&file).unwrap();
        for (helper, case_insensitive) in HELPERS {
            for (offset, _) in source.match_indices(helper) {
                let before = source[..offset].chars().next_back();
                if before.is_some_and(|character| character.is_alphanumeric() || character == '_') {
                    continue;
                }
                if source[..offset].ends_with("fn ") {
                    continue;
                }
                let argument = &source[offset + helper.len()..];
                let Some(pattern) = leading_literal(argument) else {
                    assert!(
                        COMPOSED.iter().any(|(path, _)| *path == relative),
                        "{relative}: {helper}..) must take a string literal"
                    );
                    continue;
                };
                let result = if *case_insensitive {
                    RegexBuilder::new(&pattern).case_insensitive(true).build()
                } else {
                    Regex::new(&pattern)
                };
                assert!(result.is_ok(), "{relative}: {pattern:?}: {result:?}");
                compiled += 1;
            }
        }
    }
    assert!(
        compiled > 50,
        "scanner found only {compiled} fixed patterns"
    );
}

#[test]
fn composed_public_text_patterns_compile() {
    // Forces `Patterns::new`, which composes its patterns from constants.
    assert_eq!(
        crate::public_text::sanitize_public_text("hello", "-"),
        "hello"
    );
}
