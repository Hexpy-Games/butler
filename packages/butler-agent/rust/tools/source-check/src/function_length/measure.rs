//! Measures every function body in one source file.

use std::collections::BTreeMap;

use quote::ToTokens;
use syn::visit::{self, Visit};
use syn::{Block, ImplItemFn, ItemFn, ItemImpl, ItemMod, ItemTrait, Signature, TraitItemFn, Type};

/// One function's qualified name inside its file and its line count, from the
/// line holding `fn` through the line holding the body's closing brace.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Function {
    pub name: String,
    pub lines: usize,
}

/// Every function with a body in `source`, in source order. Names are scoped
/// by inline module, impl/trait and enclosing function; repeated names in one
/// file are numbered `#2`, `#3`, .. in source order.
pub(super) fn functions(source: &str) -> Result<Vec<Function>, syn::Error> {
    let file = syn::parse_file(source)?;
    let mut collector = Collector::default();
    collector.visit_file(&file);
    let mut seen = BTreeMap::<String, usize>::new();
    for function in &mut collector.functions {
        let count = seen.entry(function.name.clone()).or_default();
        *count += 1;
        if *count > 1 {
            function.name = format!("{}#{count}", function.name);
        }
    }
    Ok(collector.functions)
}

#[derive(Default)]
struct Collector {
    scope: Vec<String>,
    functions: Vec<Function>,
}

impl Collector {
    fn record(&mut self, signature: &Signature, block: &Block) {
        let start = signature.fn_token.span.start().line;
        let end = block.brace_token.span.close().end().line;
        let mut name = self.scope.clone();
        name.push(signature.ident.to_string());
        self.functions.push(Function {
            name: name.join("::"),
            lines: end.saturating_sub(start) + 1,
        });
    }

    fn scoped(&mut self, name: String, visit: impl FnOnce(&mut Self)) {
        self.scope.push(name);
        visit(self);
        self.scope.pop();
    }
}

impl<'ast> Visit<'ast> for Collector {
    fn visit_item_fn(&mut self, item: &'ast ItemFn) {
        self.record(&item.sig, &item.block);
        self.scoped(item.sig.ident.to_string(), |this| {
            visit::visit_item_fn(this, item);
        });
    }

    fn visit_impl_item_fn(&mut self, item: &'ast ImplItemFn) {
        self.record(&item.sig, &item.block);
        self.scoped(item.sig.ident.to_string(), |this| {
            visit::visit_impl_item_fn(this, item);
        });
    }

    fn visit_trait_item_fn(&mut self, item: &'ast TraitItemFn) {
        if let Some(block) = &item.default {
            self.record(&item.sig, block);
        }
        self.scoped(item.sig.ident.to_string(), |this| {
            visit::visit_trait_item_fn(this, item);
        });
    }

    fn visit_item_mod(&mut self, item: &'ast ItemMod) {
        self.scoped(item.ident.to_string(), |this| {
            visit::visit_item_mod(this, item);
        });
    }

    fn visit_item_impl(&mut self, item: &'ast ItemImpl) {
        let owner = type_name(&item.self_ty);
        let name = match &item.trait_ {
            Some((_, path, _)) => {
                let trait_name = path
                    .segments
                    .last()
                    .map_or_else(String::new, |segment| segment.ident.to_string());
                format!("<{owner} as {trait_name}>")
            }
            None => owner,
        };
        self.scoped(name, |this| visit::visit_item_impl(this, item));
    }

    fn visit_item_trait(&mut self, item: &'ast ItemTrait) {
        self.scoped(item.ident.to_string(), |this| {
            visit::visit_item_trait(this, item);
        });
    }
}

/// The last path segment of a named type, or the whole type without spaces.
fn type_name(ty: &Type) -> String {
    if let Type::Path(path) = ty
        && let Some(segment) = path.path.segments.last()
    {
        return segment.ident.to_string();
    }
    ty.to_token_stream()
        .to_string()
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{Function, functions};

    fn measured(source: &str) -> Vec<(String, usize)> {
        functions(source)
            .unwrap()
            .into_iter()
            .map(|Function { name, lines }| (name, lines))
            .collect()
    }

    #[test]
    fn counts_signature_through_closing_brace_and_scopes_names() {
        let source = "\
/// docs are not counted
#[inline]
pub fn free(
    a: u8,
) -> u8 {
    a
}
mod inner {
    struct S;
    impl S {
        fn method(&self) {}
    }
    impl Clone for S {
        fn clone(&self) -> Self {
            fn helper() {}
            S
        }
    }
    trait T {
        fn required(&self);
        fn provided(&self) {
        }
    }
}
fn free() {}
";
        assert_eq!(
            measured(source),
            [
                ("free".to_owned(), 5),
                ("inner::S::method".to_owned(), 1),
                ("inner::<S as Clone>::clone".to_owned(), 4),
                ("inner::<S as Clone>::clone::helper".to_owned(), 1),
                ("inner::T::provided".to_owned(), 2),
                ("free#2".to_owned(), 1),
            ]
        );
    }

    #[test]
    fn rejects_invalid_syntax() {
        assert!(functions("fn broken( {").is_err());
    }
}
