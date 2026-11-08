//! Keeps shell and design-system animation scheduling behind the motion helpers.

use std::fs;
use std::path::{Path, PathBuf};

use syn::visit::{self, Visit};
use syn::{Expr, ExprMethodCall, Member};

pub(crate) fn check(root: &Path, sources: &[PathBuf]) -> Result<bool, String> {
    let mut violations = 0;
    for source in sources {
        let path = format!("/{}", source.to_string_lossy().replace('\\', "/"));
        if !path.contains("/src/")
            || !["butler-ds", "butler-shell", "butler-ds-view"]
                .iter()
                .any(|name| path.contains(&format!("/crates/{name}/")))
            || path.ends_with("/crates/butler-ds/src/ui/motion.rs")
        {
            continue;
        }
        let contents = fs::read_to_string(source)
            .map_err(|error| format!("cannot read {}: {error}", source.display()))?;
        let file = syn::parse_file(&contents)
            .map_err(|error| format!("invalid Rust syntax in {}: {error}", source.display()))?;
        let mut visitor = AnimationFrames::default();
        visitor.visit_file(&file);
        let relative = source.strip_prefix(root).unwrap_or(source);
        for (line, what) in visitor.violations {
            eprintln!(
                "PERF ERROR {}:{line} {what}; animation goes through butler_ds::ui::motion (LayerMotion) and its helpers",
                relative.to_string_lossy().replace('\\', "/")
            );
            violations += 1;
        }
    }
    println!("PERF animation-frame-calls={violations}");
    Ok(violations > 0)
}

#[derive(Default)]
struct AnimationFrames {
    violations: Vec<(usize, &'static str)>,
}

impl<'ast> Visit<'ast> for AnimationFrames {
    fn visit_expr_method_call(&mut self, expression: &'ast ExprMethodCall) {
        let background_executor = match expression.receiver.as_ref() {
            Expr::MethodCall(call) => call.method == "background_executor",
            Expr::Field(field) => {
                matches!(&field.member, Member::Named(name) if name == "background_executor")
            }
            Expr::Call(call) => match call.func.as_ref() {
                Expr::Path(path) => path
                    .path
                    .segments
                    .last()
                    .is_some_and(|segment| segment.ident == "background_executor"),
                Expr::Field(field) => {
                    matches!(&field.member, Member::Named(name) if name == "background_executor")
                }
                _ => false,
            },
            _ => false,
        };
        let what = match expression.method.to_string().as_str() {
            "request_animation_frame" => Some("request_animation_frame call"),
            "timer" if background_executor => Some("background_executor timer call"),
            "with_animation" => Some("with_animation call"),
            _ => None,
        };
        if let Some(what) = what {
            self.violations
                .push((expression.method.span().start().line, what));
        }
        visit::visit_expr_method_call(self, expression);
    }

    fn visit_path(&mut self, path: &'ast syn::Path) {
        if let Some(segment) = path.segments.last()
            && segment.ident == "with_animation"
        {
            self.violations
                .push((segment.ident.span().start().line, "with_animation path"));
        }
        visit::visit_path(self, path);
    }
}

#[cfg(test)]
mod tests {
    use super::AnimationFrames;
    use syn::visit::Visit as _;

    // test-category: pure-logic
    #[test]
    fn animation_frames_counts_violations() {
        for (source, count) in [
            ("fn demo() { window.request_animation_frame(); }", 1),
            (
                "async fn demo() { cx.background_executor().timer(d).await; }",
                1,
            ),
            ("fn demo() { gpui::with_animation(); }", 1),
            (
                "async fn demo() { motion::sleep(cx.background_executor(), d).await; }",
                0,
            ),
        ] {
            let mut visitor = AnimationFrames::default();
            visitor.visit_file(&syn::parse_file(source).unwrap());
            assert_eq!(visitor.violations.len(), count, "{source}");
        }
    }
}
