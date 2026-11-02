//! The module tree of a crate, as `rustc` would load it without `cfg(test)`.

use std::fs;
use std::path::{Path, PathBuf};

use syn::{Attribute, Item, Meta};

/// One logical module: its path below the crate root, the file that holds it
/// and its items.
pub(crate) struct Module {
    pub path: Vec<String>,
    pub file: PathBuf,
    pub items: Vec<Item>,
}

/// Every module reachable from the crate root `entry`, skipping modules that
/// compile only under `cfg(test)`.
pub(crate) fn load(entry: &Path) -> Result<Vec<Module>, String> {
    load_skipping(entry, test_only)
}

/// Every module a shipped binary compiles from the crate root `entry`:
/// [`load`] without the modules of the [`FIXTURE_FEATURES`] either.
pub(crate) fn load_shipped(entry: &Path) -> Result<Vec<Module>, String> {
    load_skipping(entry, fixture_only)
}

pub(crate) fn load_skipping(
    entry: &Path,
    skip: fn(&[Attribute]) -> bool,
) -> Result<Vec<Module>, String> {
    let mut modules = Vec::new();
    let file = read(entry)?;
    let mut ancestors = vec![canonical(entry)?];
    let mut tree = Tree {
        skip,
        modules: &mut modules,
        ancestors: &mut ancestors,
    };
    tree.visit(
        Vec::new(),
        entry,
        entry.parent().ok_or("entry parent missing")?,
        false,
        file.items,
    )?;
    Ok(modules)
}

/// Cargo features that only test builds enable: fixtures for the E2E harness
/// and for tests of dependent crates. Shipped binaries build without them.
pub(crate) const FIXTURE_FEATURES: &[&str] = &["e2e-fixtures", "test-support"];

struct Tree<'a> {
    skip: fn(&[Attribute]) -> bool,
    modules: &'a mut Vec<Module>,
    ancestors: &'a mut Vec<PathBuf>,
}

impl Tree<'_> {
    fn visit(
        &mut self,
        logical: Vec<String>,
        file: &Path,
        directory: &Path,
        inline: bool,
        items: Vec<Item>,
    ) -> Result<(), String> {
        for item in &items {
            let Item::Mod(child) = item else { continue };
            if (self.skip)(&child.attrs) {
                continue;
            }
            let mut path = logical.clone();
            path.push(child.ident.to_string());
            let child_directory = directory.join(child.ident.to_string());
            let attribute_base = if inline {
                directory
            } else {
                file.parent().ok_or("module parent missing")?
            };
            let override_path =
                path_attribute(&child.attrs).map(|value| attribute_base.join(value));
            if let Some((_, children)) = &child.content {
                let child_directory = override_path.as_deref().unwrap_or(&child_directory);
                self.visit(path, file, child_directory, true, children.clone())?;
                continue;
            }
            let child_file = match override_path {
                Some(path) => path,
                None => module_file(
                    &directory.join(format!("{}.rs", child.ident)),
                    &child_directory.join("mod.rs"),
                    &path,
                    file,
                )?,
            };
            let contents = read(&child_file)?;
            if (self.skip)(&contents.attrs) {
                continue;
            }
            let canonical = canonical(&child_file)?;
            if self.ancestors.contains(&canonical) {
                return Err(format!("recursive source module {}", child_file.display()));
            }
            let directory = if child_file.file_name().is_some_and(|name| name == "mod.rs") {
                child_file
                    .parent()
                    .ok_or("module parent missing")?
                    .to_owned()
            } else {
                child_file.with_extension("")
            };
            self.ancestors.push(canonical);
            self.visit(path, &child_file, &directory, false, contents.items)?;
            self.ancestors.pop();
        }
        self.modules.push(Module {
            path: logical,
            file: file.to_owned(),
            items,
        });
        Ok(())
    }
}

/// The value of a `#[path = ".."]` attribute.
fn path_attribute(attributes: &[Attribute]) -> Option<String> {
    attributes.iter().find_map(|attribute| {
        if !attribute.path().is_ident("path") {
            return None;
        }
        let Meta::NameValue(value) = &attribute.meta else {
            return None;
        };
        let syn::Expr::Lit(value) = &value.value else {
            return None;
        };
        let syn::Lit::Str(value) = &value.lit else {
            return None;
        };
        Some(value.value())
    })
}

/// Exactly one of `name.rs` and `name/mod.rs` must exist.
fn module_file(
    flat: &Path,
    nested: &Path,
    path: &[String],
    file: &Path,
) -> Result<PathBuf, String> {
    let problem = match (flat.is_file(), nested.is_file()) {
        (true, false) => return Ok(flat.to_owned()),
        (false, true) => return Ok(nested.to_owned()),
        (false, false) => "missing",
        (true, true) => "ambiguous",
    };
    Err(format!(
        "{problem} source module {} in {}",
        path.join("::"),
        file.display()
    ))
}

#[allow(
    clippy::disallowed_methods,
    reason = "repository tool without butler-platform; compares only paths it resolves here"
)]
fn canonical(path: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|error| format!("{}: {error}", path.display()))
}

fn read(path: &Path) -> Result<syn::File, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("{}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "source module symlink is not allowed: {}",
            path.display()
        ));
    }
    let contents =
        fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    syn::parse_file(&contents)
        .map_err(|error| format!("invalid Rust syntax in {}: {error}", path.display()))
}

/// Whether `attributes` compile the item only under `cfg(test)`.
pub(crate) fn test_only(attributes: &[Attribute]) -> bool {
    disabled(attributes, &|meta| {
        meta.path().is_ident("test") && matches!(meta, Meta::Path(_))
    })
}

/// Whether `attributes` compile the item only under `cfg(test)` or one of the
/// [`FIXTURE_FEATURES`].
pub(crate) fn fixture_only(attributes: &[Attribute]) -> bool {
    disabled(attributes, &|meta| match meta {
        Meta::Path(path) => path.is_ident("test"),
        Meta::NameValue(value) => {
            value.path.is_ident("feature")
                && matches!(&value.value, syn::Expr::Lit(syn::ExprLit { lit: syn::Lit::Str(name), .. })
                    if FIXTURE_FEATURES.contains(&name.value().as_str()))
        }
        Meta::List(_) => false,
    })
}

/// Whether a `cfg` among `attributes` is false whenever every `off` predicate is.
fn disabled(attributes: &[Attribute], off: &dyn Fn(&Meta) -> bool) -> bool {
    attributes.iter().any(|attribute| {
        attribute.path().is_ident("cfg")
            && attribute
                .parse_args::<Meta>()
                .is_ok_and(|meta| condition(&meta, off) == Some(false))
    })
}

/// Whether `attributes` mark a test function: `#[test]`, `#[tokio::test]`, ...
pub(crate) fn test_function(attributes: &[Attribute]) -> bool {
    attributes.iter().any(|attribute| {
        attribute
            .path()
            .segments
            .last()
            .is_some_and(|segment| segment.ident == "test")
    })
}

fn condition(meta: &Meta, off: &dyn Fn(&Meta) -> bool) -> Option<bool> {
    match meta {
        meta if off(meta) => Some(false),
        Meta::List(list) => {
            let children = list
                .parse_args_with(
                    syn::punctuated::Punctuated::<Meta, syn::Token![,]>::parse_terminated,
                )
                .ok()?;
            let values: Vec<_> = children.iter().map(|child| condition(child, off)).collect();
            if list.path.is_ident("all") {
                if values.contains(&Some(false)) {
                    Some(false)
                } else if values.iter().all(|value| *value == Some(true)) {
                    Some(true)
                } else {
                    None
                }
            } else if list.path.is_ident("any") {
                if values.contains(&Some(true)) {
                    Some(true)
                } else if values.iter().all(|value| *value == Some(false)) {
                    Some(false)
                } else {
                    None
                }
            } else if list.path.is_ident("not") && values.len() == 1 {
                values[0].map(|v| !v)
            } else {
                None
            }
        }
        _ => None,
    }
}

pub(crate) fn item_attributes(item: &Item) -> &[Attribute] {
    match item {
        Item::Const(v) => &v.attrs,
        Item::Enum(v) => &v.attrs,
        Item::ExternCrate(v) => &v.attrs,
        Item::Fn(v) => &v.attrs,
        Item::ForeignMod(v) => &v.attrs,
        Item::Impl(v) => &v.attrs,
        Item::Macro(v) => &v.attrs,
        Item::Mod(v) => &v.attrs,
        Item::Static(v) => &v.attrs,
        Item::Struct(v) => &v.attrs,
        Item::Trait(v) => &v.attrs,
        Item::TraitAlias(v) => &v.attrs,
        Item::Type(v) => &v.attrs,
        Item::Union(v) => &v.attrs,
        Item::Use(v) => &v.attrs,
        _ => &[],
    }
}
