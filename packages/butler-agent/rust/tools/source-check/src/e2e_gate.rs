//! Agent scenarios must gate before calling any helper that can build or launch it.
use std::fs;
use std::path::{Path, PathBuf};

use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{ItemFn, Stmt};

pub(crate) fn check(root: &Path, sources: &[PathBuf]) -> Result<bool, String> {
    let directory = root.join("crates/butler-e2e/tests");
    let mut violations = 0;
    for source in sources
        .iter()
        .filter(|source| source.starts_with(&directory))
    {
        // This harness-only inventory/security suite never accesses an Agent.
        if source == &directory.join("e2e/cassette_lint.rs") {
            continue;
        }
        let contents = fs::read_to_string(source).map_err(|error| error.to_string())?;
        for (line, name) in ungated(&contents)? {
            eprintln!(
                "E2E GATE ERROR {}:{line} {name} must begin with butler_e2e::gate!()",
                source.strip_prefix(root).unwrap_or(source).display()
            );
            violations += 1;
        }
    }
    println!("E2E GATE violations={violations}");
    Ok(violations > 0)
}

pub(crate) fn ungated(contents: &str) -> Result<Vec<(usize, String)>, String> {
    let parsed = syn::parse_file(contents).map_err(|error| error.to_string())?;
    let mut finder = Finder::default();
    finder.visit_file(&parsed);
    Ok(finder.violations)
}

#[derive(Default)]
struct Finder {
    violations: Vec<(usize, String)>,
}

impl<'ast> Visit<'ast> for Finder {
    fn visit_item_fn(&mut self, item: &'ast ItemFn) {
        if crate::modules::test_function(&item.attrs) && !first_gate(item) {
            self.violations
                .push((item.span().start().line, item.sig.ident.to_string()));
        }
        visit::visit_item_fn(self, item);
    }
}

fn first_gate(item: &ItemFn) -> bool {
    let Some(Stmt::Macro(statement)) = item
        .block
        .stmts
        .iter()
        .find(|statement| !matches!(statement, Stmt::Item(syn::Item::Use(_))))
    else {
        return false;
    };
    let path = &statement.mac.path;
    path.segments.len() == 2
        && path.segments[0].ident == "butler_e2e"
        && path.segments[1].ident == "gate"
        && statement.mac.tokens.is_empty()
}
