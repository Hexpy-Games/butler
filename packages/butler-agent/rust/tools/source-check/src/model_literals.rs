//! Model identity belongs to the catalog, including provider wire policies.
use proc_macro2::{TokenStream, TokenTree};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};
use syn::visit::Visit;

pub(crate) fn check(root: &Path, sources: &[PathBuf]) -> Result<bool, String> {
    let catalog = sources
        .iter()
        .find(|path| path.ends_with("models/catalog/static_data.rs"))
        .ok_or_else(|| "model literal check requires the bundled catalog".to_owned())?;
    let catalog_path = catalog.with_file_name("static-catalog.json");
    let data: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(catalog_path).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let ids = data["models"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|model| [model["model_id"].as_str(), model["model_ref"].as_str()])
        .flatten()
        .map(str::to_owned)
        .collect::<HashSet<_>>();
    let mut failed = false;
    for path in sources {
        let name = path.to_string_lossy().replace('\\', "/");
        if name.contains("/catalog/")
            || name.contains("/butler-e2e/")
            || name.contains("/tests/")
            || name.ends_with("tests.rs")
            || name.contains("/source-check/")
        {
            continue;
        }
        let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        let file = syn::parse_file(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut scan = Scan {
            ids: &ids,
            path,
            failed: false,
        };
        scan.visit_file(&file);
        failed |= scan.failed;
    }
    println!(
        "MODEL-LITERALS catalog ownership checked under {}",
        root.display()
    );
    Ok(failed)
}
struct Scan<'a> {
    ids: &'a HashSet<String>,
    path: &'a Path,
    failed: bool,
}
impl Scan<'_> {
    fn literal(&mut self, value: &syn::LitStr) {
        if value
            .value()
            .split(|ch: char| !ch.is_ascii_alphanumeric() && !"-/._".contains(ch))
            .any(|word| self.ids.contains(word) || model_id(word))
        {
            eprintln!(
                "ERROR {}:{} model-id literal must live in catalog/presets or tests",
                self.path.display(),
                value.span().start().line
            );
            self.failed = true;
        }
    }
    fn tokens(&mut self, tokens: TokenStream) {
        for token in tokens {
            match token {
                TokenTree::Group(group) => self.tokens(group.stream()),
                TokenTree::Literal(value) => {
                    if let Ok(value) =
                        syn::parse2::<syn::LitStr>(TokenStream::from(TokenTree::Literal(value)))
                    {
                        self.literal(&value);
                    }
                }
                _ => {}
            }
        }
    }
}
impl<'ast> Visit<'ast> for Scan<'_> {
    fn visit_item_mod(&mut self, item: &'ast syn::ItemMod) {
        if item.attrs.iter().any(|attr| {
            attr.path().is_ident("cfg") && quote::quote!(#attr).to_string().contains("test")
        }) {
            return;
        }
        syn::visit::visit_item_mod(self, item);
    }
    fn visit_lit_str(&mut self, value: &'ast syn::LitStr) {
        self.literal(value);
    }
    fn visit_macro(&mut self, value: &'ast syn::Macro) {
        self.tokens(value.tokens.clone());
    }
    fn visit_attribute(&mut self, value: &'ast syn::Attribute) {
        if !value.path().is_ident("doc") {
            self.tokens(quote::quote!(#value));
        }
    }
}
fn model_id(value: &str) -> bool {
    let value = value
        .rsplit('/')
        .next()
        .unwrap_or(value)
        .to_ascii_lowercase();
    [
        "gpt-",
        "gemini-",
        "grok-",
        "glm-",
        "qwen",
        "kimi-k",
        "minimax-m",
        "mimo-v",
        "claude-opus-",
        "claude-sonnet-",
        "claude-haiku-",
        "claude-fable-",
    ]
    .iter()
    .any(|prefix| {
        value
            .strip_prefix(prefix)
            .is_some_and(|tail| tail.starts_with(|ch: char| ch.is_ascii_digit()))
    }) || value.as_bytes().first() == Some(&b'o')
        && value.as_bytes().get(1).is_some_and(u8::is_ascii_digit)
}
