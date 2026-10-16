//! Test-hook ratchet for shipped code. Production code must not behave
//! differently under test, so a shipped source file must not name the E2E
//! harness: a string literal that reads a `BUTLER_E2E_*` variable, names an
//! `e2e-*` marker file or a `/_test/` route counts against its package's line
//! in [`BASELINE_FILE`]. Counts may only shrink; a shrunk count fails until
//! the baseline is regenerated with `--bless`, which never raises a count.
//!
//! Shipped code is what release builds compile: `cfg(test)` code, test
//! functions, integration tests, the test-only packages and code behind a
//! [`crate::modules::FIXTURE_FEATURES`] feature are not counted. Move a fault
//! or barrier to the harness, or behind the `e2e-fixtures` feature.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use proc_macro2::{TokenStream, TokenTree};
use syn::visit::{self, Visit};

use crate::function_length::{Mode, canonical, production_files, split_package};
use crate::modules::{FIXTURE_FEATURES, fixture_only, load_shipped, test_function};

const BASELINE_FILE: &str = "source-check-e2e-hooks.txt";
/// The checker names the patterns it looks for.
const CHECKER: &str = "tools/source-check";
const BASELINE_HEADER: &str = "\
# Test hooks in shipped code, ratcheted by tools/source-check: string literals
# naming a BUTLER_E2E_* variable, an e2e-* marker file or a /_test/ route.
# Move each hook to the E2E harness or behind the `e2e-fixtures` feature.
# Counts may only shrink; regenerate with
#   cargo run -p butler-source-check -- --bless .
# package<TAB>hooks
";

type Packages = BTreeMap<String, usize>;

pub(crate) fn check(root: &Path, sources: &[PathBuf], mode: Mode) -> Result<bool, String> {
    let shipped = production_files(root, load_shipped)?;
    let mut found = Packages::new();
    for source in sources {
        let relative = source.strip_prefix(root).unwrap_or(source);
        let (package, _) = split_package(relative);
        let package = package.to_string_lossy().replace('\\', "/");
        if package == CHECKER || !shipped.contains(&canonical(source)?) {
            continue;
        }
        let contents = fs::read_to_string(source)
            .map_err(|error| format!("cannot read {}: {error}", source.display()))?;
        let hooks = hooks(&contents)
            .map_err(|error| format!("invalid Rust syntax in {}: {error}", source.display()))?;
        let displayed = relative.to_string_lossy().replace('\\', "/");
        for (line, literal) in &hooks {
            println!("E2E-HOOK {displayed}:{line} {literal:?}");
        }
        *found.entry(package).or_default() += hooks.len();
    }
    found.retain(|_, count| *count > 0);

    let path = root.join(BASELINE_FILE);
    let baseline = read_baseline(&path)?;
    let violations = if mode == Mode::Bless {
        let grown = compare(&found, &baseline, true);
        if grown == 0 {
            write_baseline(&path, &found)?;
        }
        grown
    } else {
        compare(&found, &baseline, false)
    };
    for (package, count) in &found {
        println!("E2E-HOOKS package={package} hooks={count}");
    }
    println!(
        "E2E-HOOKS hooks={} violations={violations}",
        found.values().sum::<usize>()
    );
    Ok(violations > 0)
}

/// `(line, literal)` of every test hook literal in shipped code of `source`.
pub(crate) fn hooks(source: &str) -> Result<Vec<(usize, String)>, syn::Error> {
    let file = syn::parse_file(source)?;
    let mut finder = Finder::default();
    finder.visit_file(&file);
    Ok(finder.hooks)
}

/// Whether a string literal names the E2E harness: a `BUTLER_E2E_*` variable,
/// a path segment naming an `e2e-*` marker file, or a `_test` route segment.
/// The fixture feature names themselves are how hooks leave shipped code.
fn hook(value: &str) -> bool {
    if FIXTURE_FEATURES.contains(&value) {
        return false;
    }
    value.contains("BUTLER_E2E_")
        || value
            .split(['/', '\\'])
            .any(|segment| segment.starts_with("e2e-") || segment == "_test")
}

#[derive(Default)]
struct Finder {
    hooks: Vec<(usize, String)>,
}

impl Finder {
    fn literal(&mut self, value: &syn::LitStr) {
        self.text(value.span().start().line, value.value());
    }

    fn text(&mut self, line: usize, text: String) {
        if hook(&text) {
            self.hooks.push((line, text));
        }
    }

    fn tokens(&mut self, tokens: TokenStream) {
        for token in tokens {
            match token {
                TokenTree::Group(group) => self.tokens(group.stream()),
                TokenTree::Literal(literal) => {
                    match syn::parse2::<syn::Lit>(TokenStream::from(TokenTree::Literal(literal))) {
                        Ok(syn::Lit::Str(value)) => self.literal(&value),
                        Ok(syn::Lit::ByteStr(value)) => self.text(
                            value.span().start().line,
                            String::from_utf8_lossy(&value.value()).into_owned(),
                        ),
                        _ => {}
                    }
                }
                _ => {}
            }
        }
    }
}

impl<'ast> Visit<'ast> for Finder {
    fn visit_item(&mut self, item: &'ast syn::Item) {
        if !fixture_only(crate::modules::item_attributes(item)) {
            visit::visit_item(self, item);
        }
    }
    fn visit_item_fn(&mut self, item: &'ast syn::ItemFn) {
        if !test_function(&item.attrs) {
            visit::visit_item_fn(self, item);
        }
    }
    fn visit_impl_item(&mut self, item: &'ast syn::ImplItem) {
        let attributes = match item {
            syn::ImplItem::Const(item) => &item.attrs,
            syn::ImplItem::Fn(item) => &item.attrs,
            syn::ImplItem::Type(item) => &item.attrs,
            syn::ImplItem::Macro(item) => &item.attrs,
            _ => return visit::visit_impl_item(self, item),
        };
        if !fixture_only(attributes) {
            visit::visit_impl_item(self, item);
        }
    }
    fn visit_stmt(&mut self, statement: &'ast syn::Stmt) {
        let attributes = match statement {
            syn::Stmt::Local(local) => &local.attrs,
            syn::Stmt::Macro(item) => &item.attrs,
            syn::Stmt::Expr(expression, _) => expression_attributes(expression),
            syn::Stmt::Item(_) => &[][..],
        };
        if !fixture_only(attributes) {
            visit::visit_stmt(self, statement);
        }
    }
    fn visit_impl_item_fn(&mut self, item: &'ast syn::ImplItemFn) {
        if !test_function(&item.attrs) {
            visit::visit_impl_item_fn(self, item);
        }
    }
    fn visit_attribute(&mut self, attribute: &'ast syn::Attribute) {
        // Doc comments describe hooks; they never read one.
        if !attribute.path().is_ident("doc") {
            visit::visit_attribute(self, attribute);
        }
    }
    fn visit_lit_str(&mut self, value: &'ast syn::LitStr) {
        self.literal(value);
    }
    fn visit_lit_byte_str(&mut self, value: &'ast syn::LitByteStr) {
        self.text(
            value.span().start().line,
            String::from_utf8_lossy(&value.value()).into_owned(),
        );
    }
    fn visit_macro(&mut self, value: &'ast syn::Macro) {
        self.tokens(value.tokens.clone());
    }
}

/// Outer attributes of the expression kinds that carry statement `cfg`s.
fn expression_attributes(expression: &syn::Expr) -> &[syn::Attribute] {
    match expression {
        syn::Expr::If(value) => &value.attrs,
        syn::Expr::Call(value) => &value.attrs,
        syn::Expr::MethodCall(value) => &value.attrs,
        syn::Expr::Await(value) => &value.attrs,
        syn::Expr::Try(value) => &value.attrs,
        syn::Expr::Block(value) => &value.attrs,
        syn::Expr::Match(value) => &value.attrs,
        syn::Expr::Assign(value) => &value.attrs,
        syn::Expr::Macro(value) => &value.attrs,
        syn::Expr::Let(value) => &value.attrs,
        _ => &[],
    }
}

/// Reports every package whose count differs from the baseline; with
/// `growth_only` (blessing) only counts that grew.
pub(crate) fn compare(found: &Packages, baseline: &Packages, growth_only: bool) -> usize {
    let mut violations = 0;
    let packages: std::collections::BTreeSet<_> = found.keys().chain(baseline.keys()).collect();
    for package in packages {
        let found = found.get(package).copied().unwrap_or_default();
        let allowed = baseline.get(package).copied().unwrap_or_default();
        if found > allowed {
            eprintln!(
                "E2E-HOOKS ERROR {package}: {found} test hooks in shipped code, baseline {allowed}; move the hook to the E2E harness or behind the `e2e-fixtures` feature"
            );
            violations += 1;
        } else if !growth_only && found < allowed {
            eprintln!(
                "E2E-HOOKS ERROR {package}: {found} test hooks, baseline {allowed}; ratchet it with --bless"
            );
            violations += 1;
        }
    }
    violations
}

fn read_baseline(path: &Path) -> Result<Packages, String> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Packages::new()),
        Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
    };
    let mut packages = Packages::new();
    for (index, line) in contents.lines().enumerate() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut fields = line.split('\t');
        let (Some(package), Some(Ok(count)), None) =
            (fields.next(), fields.next().map(str::parse), fields.next())
        else {
            return Err(format!(
                "{}:{}: expected PACKAGE<TAB>HOOKS",
                path.display(),
                index + 1
            ));
        };
        packages.insert(package.to_owned(), count);
    }
    Ok(packages)
}

fn write_baseline(path: &Path, packages: &Packages) -> Result<(), String> {
    let mut contents = BASELINE_HEADER.to_owned();
    for (package, count) in packages {
        contents.push_str(&format!("{package}\t{count}\n"));
    }
    fs::write(path, contents).map_err(|error| format!("cannot write {}: {error}", path.display()))
}
