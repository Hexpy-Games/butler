//! Finds the test functions of one source file and their category markers.

use std::collections::BTreeSet;

use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{Attribute, ItemFn, Signature};

use super::CATEGORIES;
use crate::modules::test_function;

const MARKER: &str = "// test-category:";

/// The test functions of one file: how many there are, how many carry no
/// marker, and `(line, problem)` for every malformed or stray marker.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct FileTests {
    pub tests: usize,
    pub unmarked: usize,
    pub problems: Vec<(usize, String)>,
}

/// Scans `source`. A marker belongs to a test when it sits in the comment
/// lines directly above the test or between its attributes and `fn`.
pub(super) fn tests(source: &str) -> Result<FileTests, syn::Error> {
    let file = syn::parse_file(source)?;
    let mut finder = Finder::default();
    finder.visit_file(&file);
    let lines: Vec<&str> = source.lines().collect();
    let mut result = FileTests::default();
    let mut attached = BTreeSet::new();
    for (first, fn_line) in finder.tests {
        result.tests += 1;
        let mut start = first;
        while start > 1 && is_plain_comment(lines.get(start - 2).copied().unwrap_or_default()) {
            start -= 1;
        }
        let marker = (start..=fn_line).find(|line| marker_line(&lines, *line).is_some());
        match marker {
            Some(line) => {
                attached.insert(line);
            }
            None => result.unmarked += 1,
        }
    }
    for number in 1..=lines.len() {
        let Some(category) = marker_line(&lines, number) else {
            continue;
        };
        if !CATEGORIES.contains(&category) {
            result.problems.push((
                number,
                format!(
                    "unknown test category `{category}`; use one of {}",
                    CATEGORIES.join(", ")
                ),
            ));
        } else if !attached.contains(&number) {
            result.problems.push((
                number,
                "test-category marker is not directly above a test function".to_owned(),
            ));
        }
    }
    Ok(result)
}

/// The category named on 1-based `line`, when that line is a marker.
fn marker_line<'a>(lines: &[&'a str], line: usize) -> Option<&'a str> {
    let text = lines.get(line.checked_sub(1)?)?.trim();
    text.strip_prefix(MARKER).map(str::trim)
}

fn is_plain_comment(line: &str) -> bool {
    let line = line.trim_start();
    line.starts_with("//") && !line.starts_with("//!")
}

/// `(first line of the attributes, line of `fn`)` of every test function.
#[derive(Default)]
struct Finder {
    tests: Vec<(usize, usize)>,
}

impl Finder {
    fn record(&mut self, attributes: &[Attribute], signature: &Signature) {
        if !test_function(attributes) {
            return;
        }
        let fn_line = signature.fn_token.span.start().line;
        let first = attributes
            .iter()
            .map(|attribute| attribute.span().start().line)
            .min()
            .unwrap_or(fn_line)
            .min(fn_line);
        self.tests.push((first, fn_line));
    }
}

impl<'ast> Visit<'ast> for Finder {
    fn visit_item_fn(&mut self, item: &'ast ItemFn) {
        self.record(&item.attrs, &item.sig);
        visit::visit_item_fn(self, item);
    }
}

#[cfg(test)]
mod tests {
    use super::{FileTests, tests};

    /// Pure-logic table: test functions are counted in every module, and a
    /// marker counts only directly above its test with a known category.
    // test-category: pure-logic
    #[test]
    fn counts_test_metadata_and_rejects_unguarded_scenarios() {
        for (body, violations) in [
            ("butler_e2e::gate!(); helper();", 0),
            ("use crate::Helper; butler_e2e::gate!(); helper();", 0),
            ("helper(); butler_e2e::gate!();", 1),
            ("if false { butler_e2e::gate!(); } helper();", 1),
            ("let text = \"butler_e2e::gate!();\"; helper();", 1),
            ("helper();", 1),
        ] {
            let source = format!("#[tokio::test] async fn scenario() {{ {body} }}");
            assert_eq!(crate::e2e_gate::ungated(&source).unwrap().len(), violations);
        }
        let marked = "// test-category: race\n#[test]\nfn a() {}\n";
        let doc_then_marker = "/// Why.\n// test-category: format-pin\n#[tokio::test(flavor = \"multi_thread\")]\nasync fn a() {}\n";
        let between_attributes = "#[cfg(unix)]\n// test-category: security\n#[test]\nfn a() {}\n";
        let unmarked = "#[test]\nfn a() {}\nmod inner {\n    #[tokio::test]\n    async fn b() {}\n}\nfn helper() {}\n";
        let unknown = "// test-category: slow\n#[test]\nfn a() {}\n";
        let stray = "// test-category: race\n\n#[test]\nfn a() {}\n";
        let not_a_test = "// test-category: race\nfn helper() {}\n";
        let in_string = "#[test]\nfn a() { let _ = \"// test-category: race\"; }\n";
        // (source, tests, unmarked, problem lines)
        for (source, count, without, problems) in [
            (marked, 1, 0, vec![]),
            (doc_then_marker, 1, 0, vec![]),
            (between_attributes, 1, 0, vec![]),
            (unmarked, 2, 2, vec![]),
            (unknown, 1, 0, vec![1]),
            (stray, 1, 1, vec![1]),
            (not_a_test, 0, 0, vec![1]),
            (in_string, 1, 1, vec![]),
        ] {
            let FileTests {
                tests: found,
                unmarked,
                problems: reported,
            } = tests(source).unwrap();
            let lines: Vec<usize> = reported.iter().map(|(line, _)| *line).collect();
            assert_eq!(
                (found, unmarked, lines),
                (count, without, problems),
                "{source}"
            );
        }
        assert!(tests("fn broken( {").is_err());
    }
}
