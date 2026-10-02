//! Requires tier-aware helpers for upper wall-clock budget assertions.

use std::fs;
use std::path::{Component, Path, PathBuf};

use syn::punctuated::Punctuated;
use syn::visit::{self, Visit};
use syn::{Expr, ExprBinary, ItemFn, Macro, Token};

const E2E_TEST_PATH: &[&str] = &["crates", "butler-e2e", "tests"];

pub(crate) fn check(root: &Path, sources: &[PathBuf]) -> Result<bool, String> {
    let mut violations = 0;
    for source in sources {
        let relative = source.strip_prefix(root).unwrap_or(source);
        if !is_e2e_test_source(relative) {
            continue;
        }
        let contents = fs::read_to_string(source)
            .map_err(|error| format!("cannot read {}: {error}", source.display()))?;
        let findings = raw_budget_assertions(&contents)
            .map_err(|error| format!("invalid Rust syntax in {}: {error}", source.display()))?;
        for (line, name) in findings {
            eprintln!(
                "PERF ERROR {}:{line} function `{name}` asserts a raw wall-clock budget; use `butler_e2e::assert_wall_clock_budget!`",
                relative.to_string_lossy().replace('\\', "/")
            );
            violations += 1;
        }
    }
    println!("PERF raw-wall-clock-budget-assertions={violations}");
    Ok(violations > 0)
}

fn is_e2e_test_source(path: &Path) -> bool {
    let mut parts = path.components().filter_map(|component| match component {
        Component::Normal(part) => part.to_str(),
        _ => None,
    });
    E2E_TEST_PATH
        .iter()
        .all(|expected| parts.next() == Some(*expected))
}

pub(crate) fn raw_budget_assertions(source: &str) -> Result<Vec<(usize, String)>, syn::Error> {
    let file = syn::parse_file(source)?;
    let mut finder = BudgetTests::default();
    finder.visit_file(&file);
    Ok(finder.untiered)
}

#[derive(Default)]
struct BudgetTests {
    untiered: Vec<(usize, String)>,
}

impl<'ast> Visit<'ast> for BudgetTests {
    fn visit_item_fn(&mut self, item: &'ast ItemFn) {
        if has_budget_assertion(item) {
            self.untiered.push((
                item.sig.ident.span().start().line,
                item.sig.ident.to_string(),
            ));
        }
        visit::visit_item_fn(self, item);
    }
}

fn has_budget_assertion(item: &ItemFn) -> bool {
    let mut visitor = Assertions::default();
    visitor.visit_block(&item.block);
    visitor.found
}

#[derive(Default)]
struct Assertions {
    found: bool,
}

impl<'ast> Visit<'ast> for Assertions {
    fn visit_macro(&mut self, mac: &'ast Macro) {
        if is_assertion_macro(mac) {
            let parser = Punctuated::<Expr, Token![,]>::parse_terminated;
            if let Ok(arguments) = syn::parse::Parser::parse2(parser, mac.tokens.clone())
                && arguments.first().is_some_and(has_budget_comparison)
            {
                self.found = true;
            }
        }
        visit::visit_macro(self, mac);
    }
}

fn is_assertion_macro(mac: &Macro) -> bool {
    mac.path.segments.last().is_some_and(|segment| {
        matches!(
            segment.ident.to_string().as_str(),
            "assert" | "assert_eq" | "debug_assert" | "debug_assert_eq"
        )
    })
}

fn has_budget_comparison(expression: &Expr) -> bool {
    let mut visitor = BudgetComparisons::default();
    visitor.visit_expr(expression);
    visitor.found
}

#[derive(Default)]
struct BudgetComparisons {
    found: bool,
}

impl<'ast> Visit<'ast> for BudgetComparisons {
    fn visit_expr_binary(&mut self, expression: &'ast ExprBinary) {
        if (matches!(expression.op, syn::BinOp::Lt(_) | syn::BinOp::Le(_))
            && (contains_wall_clock_value(&expression.left)
                || contains_duration(&expression.right)))
            || (matches!(expression.op, syn::BinOp::Gt(_) | syn::BinOp::Ge(_))
                && (contains_wall_clock_value(&expression.right)
                    || contains_duration(&expression.left)))
        {
            self.found = true;
        }
        visit::visit_expr_binary(self, expression);
    }
}

fn contains_duration(expression: &Expr) -> bool {
    let mut visitor = TimeExpression {
        duration_only: true,
        ..TimeExpression::default()
    };
    visitor.visit_expr(expression);
    visitor.found
}

fn contains_wall_clock_value(expression: &Expr) -> bool {
    let mut visitor = TimeExpression::default();
    visitor.visit_expr(expression);
    visitor.found
}

#[derive(Default)]
struct TimeExpression {
    found: bool,
    duration_only: bool,
}

impl<'ast> Visit<'ast> for TimeExpression {
    fn visit_expr_method_call(&mut self, expression: &'ast syn::ExprMethodCall) {
        if !self.duration_only && expression.method == "elapsed" {
            self.found = true;
        }
        visit::visit_expr_method_call(self, expression);
    }

    fn visit_expr_path(&mut self, expression: &'ast syn::ExprPath) {
        if expression.path.segments.iter().any(|segment| {
            (self.duration_only && segment.ident == "Duration")
                || (!self.duration_only
                    && segment.ident != "Duration"
                    && is_wall_clock_name(&segment.ident.to_string()))
        }) {
            self.found = true;
        }
        visit::visit_expr_path(self, expression);
    }
}

fn is_wall_clock_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name == "elapsed"
        || name.ends_with("_elapsed")
        || name == "duration"
        || name.ends_with("_duration")
        || name.contains("p50")
        || name.contains("p95")
        || name.contains("latency")
        || name == "took"
        || name.ends_with("_took")
}
