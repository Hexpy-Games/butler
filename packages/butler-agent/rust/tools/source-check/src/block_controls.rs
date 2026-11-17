//! Controls on a text line. The native shell lays out like CSS: a plain `div()` is a block, and
//! an inline-flex control (`Button`, `IconButton`, a `Tooltip` wrapper, a menu trigger, ...) put
//! directly in it sits on a line box with a strut, so it gains height or shifts a few pixels.
//! Electron hosts the same controls in flex containers. A `div()` whose builder chain sets no
//! display (`flex`, `grid`, ..) and that takes such a control as a direct `.child(..)` or
//! `.children(..)` counts against its crate's line in [`BASELINE_FILE`]; counts may only shrink,
//! and a shrunk count fails until the baseline is regenerated with `--bless`, which never raises
//! a count.
//!
//! Syntax-level. Locals holding a control or a plain block are followed inside one function
//! (`let button = Button::new(..); div().child(button)`, `row = row.child(..)`). Blind to: a
//! control reached through a helper function or a closure (`when`, `map`) other than `scoped`
//! and `anchored`; a wrapper made by another helper than `div()` and `anchor(div(), ..)`; a
//! display set through `style()`. False positives: block-level variants of a control
//! (`Tooltip::fill()`, `Clickable::stretch()`), which `is_control` does not exclude. A plain
//! `div()` that is a flex item is a true positive: it is still a block container around the
//! control.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use syn::visit::{self, Visit};
use syn::{Expr, ExprMethodCall};

use crate::function_length::Mode;

const BASELINE_FILE: &str = "source-check-controls.txt";
const BASELINE_HEADER: &str = "\
# Plain block `div()`s holding a DS control as a direct child, per crate, ratcheted by
# tools/source-check. Give the wrapper `.flex()` (or drop it) and regenerate with
#   cargo run -p butler-source-check -- --bless ../../butler-shell
# package<TAB>count
";
const CRATES: &[&str] = &["butler-ds", "butler-ds-view", "butler-shell"];
/// DS constructors whose element is inline-level (`Control`, `Tooltip`, the menu `TriggerBox`).
const CONTROLS: &[&str] = &[
    "Button",
    "IconButton",
    "PillButton",
    "Clickable",
    "Switch",
    "SegmentedControl",
    "SplitButton",
    "Tooltip",
    "Avatar",
];
/// Functions that hand their element argument back as it is (`scoped(spec, control)`,
/// `anchored(control, name)`).
const PASS_THROUGH: &[&str] = &["scoped", "anchored"];
/// Methods that wrap an element in a menu `TriggerBox` (inline-flex). Dropdown, popover and dialog
/// `.trigger(|toggle| ..)` take a `FnOnce(Toggle)` builder, so only a closure argument counts.
/// `ContextMenu::trigger(child)` and `Select::trigger(SelectTrigger, ..)` take an element and are
/// block-level (the Select trigger box uses the `fill` path, `flex().w_full()`), so neither sits
/// on a text line.
const TRIGGERS: &[&str] = &["trigger", "trigger_fill"];
/// Methods that set the display of a gpui element.
const DISPLAYS: &[&str] = &[
    "flex",
    "grid",
    "block",
    "inline",
    "inline_flex",
    "hidden",
    "display",
];

type Packages = BTreeMap<String, Vec<String>>;

pub(crate) fn check(root: &Path, sources: &[PathBuf], mode: Mode) -> Result<bool, String> {
    let mut found = Packages::new();
    for source in sources {
        let relative = source.strip_prefix(root).unwrap_or(source);
        let Some(package) = package(relative) else {
            continue;
        };
        let contents = fs::read_to_string(source)
            .map_err(|error| format!("cannot read {}: {error}", source.display()))?;
        let file = syn::parse_file(&contents)
            .map_err(|error| format!("invalid Rust syntax in {}: {error}", source.display()))?;
        let mut visitor = Sites::default();
        visitor.visit_file(&file);
        let shown = relative.to_string_lossy().replace('\\', "/");
        found
            .entry(package)
            .or_default()
            .extend(visitor.lines.iter().map(|line| format!("{shown}:{line}")));
    }

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
    for (package, sites) in &found {
        println!(
            "LAYOUT package={package} controls-in-block-div={}",
            sites.len()
        );
    }
    let total: usize = found.values().map(Vec::len).sum();
    println!("LAYOUT controls-in-block-div={total} violations={violations}");
    Ok(violations > 0)
}

/// `crates/<name>` for a file under `src/` of one of the UI crates.
fn package(relative: &Path) -> Option<String> {
    let parts: Vec<_> = relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => part.to_str(),
            _ => None,
        })
        .collect();
    match parts.as_slice() {
        ["crates", name, "src", ..] if CRATES.contains(name) => Some(format!("crates/{name}")),
        _ => None,
    }
}

fn compare(found: &Packages, baseline: &BTreeMap<String, usize>, growth_only: bool) -> usize {
    let mut violations = 0;
    let names: BTreeSet<_> = found.keys().chain(baseline.keys()).collect();
    for package in names {
        let sites = found.get(package).map_or(&[][..], Vec::as_slice);
        let allowed = baseline.get(package).copied().unwrap_or(0);
        if sites.len() > allowed {
            eprintln!(
                "LAYOUT ERROR {package}: {} controls directly in a block `div()`, baseline {allowed}; give the wrapper `.flex()` (the web hosts controls in flex boxes)",
                sites.len()
            );
            for site in sites {
                eprintln!("LAYOUT   {site}");
            }
            violations += 1;
        } else if !growth_only && sites.len() < allowed {
            eprintln!(
                "LAYOUT ERROR {package}: {} controls in block `div()`s, baseline {allowed}; ratchet it with --bless",
                sites.len()
            );
            violations += 1;
        }
    }
    violations
}

fn read_baseline(path: &Path) -> Result<BTreeMap<String, usize>, String> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
    };
    let mut packages = BTreeMap::new();
    for (index, line) in contents.lines().enumerate() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let parsed = line
            .split_once('\t')
            .and_then(|(package, count)| Some((package.to_owned(), count.parse().ok()?)));
        let Some((package, count)) = parsed else {
            return Err(format!(
                "{}:{}: expected PACKAGE<TAB>COUNT",
                path.display(),
                index + 1
            ));
        };
        packages.insert(package, count);
    }
    Ok(packages)
}

fn write_baseline(path: &Path, found: &Packages) -> Result<(), String> {
    let mut contents = BASELINE_HEADER.to_owned();
    for (package, sites) in found {
        if !sites.is_empty() {
            contents.push_str(&format!("{package}\t{}\n", sites.len()));
        }
    }
    fs::write(path, contents).map_err(|error| format!("cannot write {}: {error}", path.display()))
}

#[derive(Default)]
struct Sites {
    lines: Vec<usize>,
    /// Locals bound to a control, and to a plain block, in the function being visited.
    controls: BTreeSet<String>,
    plains: BTreeSet<String>,
}

/// A method chain from its outermost call down to the first non-method expression.
fn chain(expression: &ExprMethodCall) -> (Vec<&ExprMethodCall>, &Expr) {
    let mut calls = vec![expression];
    let mut current = expression.receiver.as_ref();
    while let Expr::MethodCall(call) = current {
        calls.push(call);
        current = call.receiver.as_ref();
    }
    (calls, current)
}

fn callee(expression: &Expr) -> Option<(&syn::ExprCall, Vec<String>)> {
    let Expr::Call(call) = expression else {
        return None;
    };
    let Expr::Path(path) = call.func.as_ref() else {
        return None;
    };
    let names = path
        .path
        .segments
        .iter()
        .map(|segment| segment.ident.to_string())
        .collect();
    Some((call, names))
}

fn is_display(call: &ExprMethodCall) -> bool {
    DISPLAYS.contains(&call.method.to_string().as_str())
}

fn local(expression: &Expr) -> Option<String> {
    match expression {
        Expr::Path(path) => path.path.get_ident().map(ToString::to_string),
        _ => None,
    }
}

impl Sites {
    /// `div()`, `gpui::div()`, `anchor(<plain div>, ..)` or a local holding one: a block with no
    /// display set so far.
    fn plain_root(&self, expression: &Expr) -> bool {
        if let Some(name) = local(expression) {
            return self.plains.contains(&name);
        }
        let Some((call, names)) = callee(expression) else {
            return false;
        };
        match names.last().map(String::as_str) {
            Some("div") => call.args.is_empty(),
            Some("anchor" | "control_anchor") => {
                call.args.first().is_some_and(|a| self.plain_div(a))
            }
            _ => false,
        }
    }

    /// A builder chain on a plain root that sets no display.
    fn plain_div(&self, expression: &Expr) -> bool {
        match expression {
            Expr::MethodCall(call) => {
                let (calls, root) = chain(call);
                self.plain_root(root) && calls.iter().all(|call| !is_display(call))
            }
            other => self.plain_root(other),
        }
    }

    /// An element built by a DS constructor that is inline-level, wrapped in a menu trigger, or a
    /// local holding one.
    fn is_control(&self, expression: &Expr) -> bool {
        let root = match expression {
            Expr::MethodCall(call) => {
                let (calls, root) = chain(call);
                if calls.iter().any(|call| {
                    TRIGGERS.contains(&call.method.to_string().as_str())
                        && matches!(call.args.first(), Some(Expr::Closure(_)))
                }) {
                    return true;
                }
                root
            }
            Expr::Array(array) => return array.elems.iter().any(|e| self.is_control(e)),
            other => other,
        };
        if let Some(name) = local(root) {
            return self.controls.contains(&name);
        }
        let Some((call, names)) = callee(root) else {
            return false;
        };
        if names
            .last()
            .is_some_and(|n| PASS_THROUGH.contains(&n.as_str()))
        {
            return call.args.iter().any(|a| self.is_control(a));
        }
        names.len() >= 2 && CONTROLS.contains(&names[names.len() - 2].as_str())
    }

    fn function(&mut self, visit: impl FnOnce(&mut Self)) {
        let saved = (
            std::mem::take(&mut self.controls),
            std::mem::take(&mut self.plains),
        );
        visit(self);
        (self.controls, self.plains) = saved;
    }
}

impl<'ast> Visit<'ast> for Sites {
    fn visit_expr_method_call(&mut self, expression: &'ast ExprMethodCall) {
        let (calls, root) = chain(expression);
        if self.plain_root(root) && calls.iter().all(|call| !is_display(call)) {
            for call in &calls {
                let method = call.method.to_string();
                if matches!(method.as_str(), "child" | "children")
                    && call.args.iter().any(|a| self.is_control(a))
                {
                    self.lines.push(call.method.span().start().line);
                }
            }
        }
        for call in &calls {
            for argument in &call.args {
                self.visit_expr(argument);
            }
        }
        self.visit_expr(root);
    }

    fn visit_local(&mut self, local_binding: &'ast syn::Local) {
        visit::visit_local(self, local_binding);
        let (Some(name), Some(init)) = (
            pat_name(&local_binding.pat),
            local_binding.init.as_ref().map(|init| init.expr.as_ref()),
        ) else {
            return;
        };
        for set in [0, 1] {
            let holds = if set == 0 {
                self.is_control(init)
            } else {
                self.plain_div(init)
            };
            let names = if set == 0 {
                &mut self.controls
            } else {
                &mut self.plains
            };
            if holds {
                names.insert(name.clone());
            } else {
                names.remove(&name);
            }
        }
    }

    /// `row = row.flex()` gives the local a display.
    fn visit_expr_assign(&mut self, assign: &'ast syn::ExprAssign) {
        visit::visit_expr_assign(self, assign);
        if let (Some(name), Expr::MethodCall(call)) = (local(&assign.left), assign.right.as_ref()) {
            let (calls, root) = chain(call);
            if local(root).as_deref() == Some(name.as_str()) && calls.iter().any(|c| is_display(c))
            {
                self.plains.remove(&name);
            }
        }
    }

    fn visit_item_fn(&mut self, function: &'ast syn::ItemFn) {
        self.function(|sites| visit::visit_item_fn(sites, function));
    }

    fn visit_impl_item_fn(&mut self, function: &'ast syn::ImplItemFn) {
        self.function(|sites| visit::visit_impl_item_fn(sites, function));
    }
}

fn pat_name(pattern: &syn::Pat) -> Option<String> {
    match pattern {
        syn::Pat::Ident(ident) => Some(ident.ident.to_string()),
        syn::Pat::Type(typed) => pat_name(&typed.pat),
        _ => None,
    }
}
