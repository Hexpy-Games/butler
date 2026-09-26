use proc_macro2::{TokenStream, TokenTree};
use syn::visit::{self, Visit};
use syn::{Item, UseTree};

use super::modules::{Module, item_attributes, test_only};

pub(super) struct References<'a> {
    module: &'a Module,
    pub(super) paths: Vec<Vec<String>>,
    pub(super) errors: Vec<String>,
}

impl<'a> References<'a> {
    pub(super) fn collect(module: &'a Module) -> Self {
        let mut visitor = Self {
            module,
            paths: Vec::new(),
            errors: Vec::new(),
        };
        for item in &module.items {
            if matches!(item, Item::Mod(_)) {
                continue;
            }
            visitor.visit_item(item);
        }
        visitor
    }

    fn path(&mut self, parts: Vec<String>) {
        let Some(first) = parts.first().map(String::as_str) else {
            return;
        };
        let (mut absolute, mut cursor) = match first {
            "crate" => (Vec::new(), 1),
            "self" => (self.module.path.clone(), 1),
            "super" => (self.module.path.clone(), 0),
            _ => return,
        };
        while parts.get(cursor).is_some_and(|part| part == "super") {
            if absolute.pop().is_none() {
                return;
            }
            cursor += 1;
        }
        absolute.extend(
            parts[cursor..]
                .iter()
                .filter(|part| part.as_str() != "self")
                .cloned(),
        );
        self.paths.push(absolute);
    }

    fn use_tree(&mut self, prefix: &[String], tree: &UseTree) {
        match tree {
            UseTree::Path(path) => {
                let mut prefix = prefix.to_vec();
                prefix.push(path.ident.to_string());
                self.use_tree(&prefix, &path.tree);
            }
            UseTree::Group(group) => {
                for child in &group.items {
                    self.use_tree(prefix, child);
                }
            }
            UseTree::Name(name) => {
                let mut parts = prefix.to_vec();
                parts.push(name.ident.to_string());
                self.path(parts);
            }
            UseTree::Rename(name) => {
                let mut parts = prefix.to_vec();
                parts.push(name.ident.to_string());
                self.path(parts);
            }
            UseTree::Glob(_) => self.path(prefix.to_vec()),
        }
    }

    fn macro_paths(&mut self, tokens: TokenStream) {
        let tokens: Vec<_> = tokens.into_iter().collect();
        for (index, token) in tokens.iter().enumerate() {
            if let TokenTree::Group(group) = token {
                self.macro_paths(group.stream());
            }
            let TokenTree::Ident(first) = token else {
                continue;
            };
            if !matches!(first.to_string().as_str(), "crate" | "self" | "super") {
                continue;
            }
            let mut parts = vec![first.to_string()];
            let mut cursor = index + 1;
            while tokens.get(cursor).is_some_and(colon) && tokens.get(cursor + 1).is_some_and(colon)
            {
                let Some(TokenTree::Ident(next)) = tokens.get(cursor + 2) else {
                    break;
                };
                parts.push(next.to_string());
                cursor += 3;
            }
            if parts.len() > 1 {
                self.path(parts);
            }
        }
    }
}

impl<'ast> Visit<'ast> for References<'_> {
    fn visit_item(&mut self, item: &'ast Item) {
        if !test_only(item_attributes(item)) {
            visit::visit_item(self, item);
        }
    }

    fn visit_item_mod(&mut self, _: &'ast syn::ItemMod) {
        self.errors
            .push("block-local modules obscure the declared module entry tree".into());
    }

    fn visit_item_use(&mut self, item: &'ast syn::ItemUse) {
        self.use_tree(&[], &item.tree);
    }

    fn visit_path(&mut self, path: &'ast syn::Path) {
        self.path(
            path.segments
                .iter()
                .map(|segment| segment.ident.to_string())
                .collect(),
        );
        visit::visit_path(self, path);
    }

    fn visit_macro(&mut self, mac: &'ast syn::Macro) {
        if mac.path.is_ident("include") {
            self.errors
                .push("include! source fragments obscure module ownership".into());
        }
        self.visit_path(&mac.path);
        self.macro_paths(mac.tokens.clone());
    }

    fn visit_impl_item(&mut self, item: &'ast syn::ImplItem) {
        let attributes = match item {
            syn::ImplItem::Const(v) => &v.attrs,
            syn::ImplItem::Fn(v) => &v.attrs,
            syn::ImplItem::Type(v) => &v.attrs,
            syn::ImplItem::Macro(v) => &v.attrs,
            _ => return,
        };
        if !test_only(attributes) {
            visit::visit_impl_item(self, item);
        }
    }

    fn visit_trait_item(&mut self, item: &'ast syn::TraitItem) {
        let attributes = match item {
            syn::TraitItem::Const(v) => &v.attrs,
            syn::TraitItem::Fn(v) => &v.attrs,
            syn::TraitItem::Type(v) => &v.attrs,
            syn::TraitItem::Macro(v) => &v.attrs,
            _ => return,
        };
        if !test_only(attributes) {
            visit::visit_trait_item(self, item);
        }
    }

    fn visit_field(&mut self, field: &'ast syn::Field) {
        if !test_only(&field.attrs) {
            visit::visit_field(self, field);
        }
    }

    fn visit_variant(&mut self, variant: &'ast syn::Variant) {
        if !test_only(&variant.attrs) {
            visit::visit_variant(self, variant);
        }
    }
}

fn colon(token: &TokenTree) -> bool {
    matches!(token, TokenTree::Punct(punctuation) if punctuation.as_char() == ':')
}
