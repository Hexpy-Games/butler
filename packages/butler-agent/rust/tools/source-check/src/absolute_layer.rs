//! Keeps absolute layers pinned: `absolute()` + `size_full()` without insets is placed by taffy
//! at the content box (below an earlier sibling in a block parent) while `size_full` resolves to
//! the padding box, so the layer shifts and overflows in a padded parent.

use std::fs;
use std::path::{Path, PathBuf};

use syn::visit::Visit;
use syn::{Expr, ExprMethodCall};

const INSETS: &[&str] = &["top_0", "left_0", "inset_0", "top", "left", "inset"];

pub(crate) fn check(root: &Path, sources: &[PathBuf]) -> Result<bool, String> {
    let mut violations = 0;
    for source in sources {
        let path = format!("/{}", source.to_string_lossy().replace('\\', "/"));
        if !path.contains("/crates/") || !path.contains("/src/") {
            continue;
        }
        let contents = fs::read_to_string(source)
            .map_err(|error| format!("cannot read {}: {error}", source.display()))?;
        let file = syn::parse_file(&contents)
            .map_err(|error| format!("invalid Rust syntax in {}: {error}", source.display()))?;
        let mut visitor = Layers::default();
        visitor.visit_file(&file);
        let relative = source.strip_prefix(root).unwrap_or(source);
        for line in visitor.lines {
            eprintln!(
                "ABSOLUTE-LAYER ERROR {}:{line}: absolute + size_full without insets; use butler_ds::ui::cover::cover()",
                relative.to_string_lossy().replace('\\', "/")
            );
            violations += 1;
        }
    }
    println!("LAYOUT absolute-layers-without-insets={violations}");
    Ok(violations > 0)
}

#[derive(Default)]
struct Layers {
    lines: Vec<usize>,
}

impl<'ast> Visit<'ast> for Layers {
    /// Judges a whole builder chain from its outermost call, then visits its arguments and base.
    fn visit_expr_method_call(&mut self, outer: &'ast ExprMethodCall) {
        let mut calls = vec![outer];
        let mut base = outer.receiver.as_ref();
        while let Expr::MethodCall(call) = base {
            calls.push(call);
            base = call.receiver.as_ref();
        }
        let named = |name: &str| calls.iter().find(|call| call.method == name);
        if let (Some(absolute), Some(_)) = (named("absolute"), named("size_full"))
            && !INSETS.iter().any(|inset| named(inset).is_some())
        {
            self.lines.push(absolute.method.span().start().line);
        }
        for call in calls {
            for argument in &call.args {
                self.visit_expr(argument);
            }
        }
        self.visit_expr(base);
    }
}
