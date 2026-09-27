use std::fs;
use std::path::{Path, PathBuf};

use syn::{Attribute, Item, Meta};

pub(super) struct Module {
    pub path: Vec<String>,
    pub file: PathBuf,
    pub items: Vec<Item>,
}

pub(super) fn load(entry: &Path) -> Result<Vec<Module>, String> {
    let mut modules = Vec::new();
    let file = read(entry)?;
    visit_modules(
        Vec::new(),
        entry,
        entry.parent().ok_or("entry parent missing")?,
        false,
        file.items,
        &mut modules,
        &mut vec![canonical(entry)?],
    )?;
    Ok(modules)
}

fn visit_modules(
    logical: Vec<String>,
    file: &Path,
    directory: &Path,
    inline: bool,
    items: Vec<Item>,
    modules: &mut Vec<Module>,
    ancestors: &mut Vec<PathBuf>,
) -> Result<(), String> {
    for item in &items {
        let Item::Mod(child) = item else { continue };
        if test_only(&child.attrs) {
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
        let override_path = child.attrs.iter().find_map(|attribute| {
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
            Some(attribute_base.join(value.value()))
        });
        if let Some((_, children)) = &child.content {
            let child_directory = override_path.as_deref().unwrap_or(&child_directory);
            visit_modules(
                path,
                file,
                child_directory,
                true,
                children.clone(),
                modules,
                ancestors,
            )?;
            continue;
        }
        let child_file = if let Some(path) = override_path {
            path
        } else {
            let flat = directory.join(format!("{}.rs", child.ident));
            let nested = child_directory.join("mod.rs");
            match (flat.is_file(), nested.is_file()) {
                (true, false) => flat,
                (false, true) => nested,
                (false, false) => {
                    return Err(format!(
                        "missing source module {} in {}",
                        path.join("::"),
                        file.display()
                    ));
                }
                (true, true) => {
                    return Err(format!(
                        "ambiguous source module {} in {}",
                        path.join("::"),
                        file.display()
                    ));
                }
            }
        };
        let contents = read(&child_file)?;
        if test_only(&contents.attrs) {
            continue;
        }
        let canonical = canonical(&child_file)?;
        if ancestors.contains(&canonical) {
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
        ancestors.push(canonical);
        visit_modules(
            path,
            &child_file,
            &directory,
            false,
            contents.items,
            modules,
            ancestors,
        )?;
        ancestors.pop();
    }
    modules.push(Module {
        path: logical,
        file: file.to_owned(),
        items,
    });
    Ok(())
}

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

pub(super) fn test_only(attributes: &[Attribute]) -> bool {
    attributes.iter().any(|attribute| {
        attribute.path().is_ident("cfg")
            && attribute
                .parse_args::<Meta>()
                .ok()
                .is_some_and(|meta| test_condition(&meta) == Some(false))
    })
}

fn test_condition(meta: &Meta) -> Option<bool> {
    match meta {
        Meta::Path(path) if path.is_ident("test") => Some(false),
        Meta::List(list) => {
            let children = list
                .parse_args_with(
                    syn::punctuated::Punctuated::<Meta, syn::Token![,]>::parse_terminated,
                )
                .ok()?;
            let values: Vec<_> = children.iter().map(test_condition).collect();
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

pub(super) fn item_attributes(item: &Item) -> &[Attribute] {
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
