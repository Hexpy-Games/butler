//! Cargo target entry points, including explicit manifest paths.
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) fn workspace_roots(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut entries = Vec::new();
    for group in ["crates", "tools"] {
        let directory = root.join(group);
        if !directory.is_dir() {
            continue;
        }
        for package in fs::read_dir(directory).map_err(|e| e.to_string())? {
            let package = package.map_err(|e| e.to_string())?.path();
            if package.join("Cargo.toml").is_file() && !test_package(&package) {
                entries.extend(roots(&package)?);
            }
        }
    }
    Ok(entries)
}

pub(crate) fn test_package(package: &Path) -> bool {
    matches!(
        package.file_name().and_then(|v| v.to_str()),
        Some("butler-e2e" | "butler-test-support")
    )
}

pub(crate) fn roots(package: &Path) -> Result<Vec<PathBuf>, String> {
    let manifest = fs::read_to_string(package.join("Cargo.toml")).map_err(|e| e.to_string())?;
    let document = toml::de::DeTable::parse(&manifest).map_err(|e| e.to_string())?;
    let manifest = document.get_ref();
    let mut entries = Vec::new();
    for (kind, default) in [("lib", "src/lib.rs"), ("build", "build.rs")] {
        let explicit = if kind == "build" {
            manifest
                .get("package")
                .and_then(|p| p.get_ref().get(kind))
                .map(toml::Spanned::get_ref)
        } else {
            manifest
                .get(kind)
                .and_then(|t| t.get_ref().get("path"))
                .map(toml::Spanned::get_ref)
        };
        if explicit.and_then(toml::de::DeValue::as_bool) != Some(false) {
            entries.push(package.join(explicit.and_then(|v| v.as_str()).unwrap_or(default)));
        }
    }
    if manifest
        .get("package")
        .ok_or("missing package table")?
        .get_ref()
        .get("autobins")
        .and_then(|v| v.get_ref().as_bool())
        != Some(false)
    {
        entries.push(package.join("src/main.rs"));
    }
    for (kind, directory, auto) in [
        ("bin", "src/bin", "autobins"),
        ("example", "examples", "autoexamples"),
    ] {
        declared_targets(package, manifest, kind, directory, &mut entries);
        if manifest
            .get("package")
            .ok_or("missing package table")?
            .get_ref()
            .get(auto)
            .and_then(|v| v.get_ref().as_bool())
            == Some(false)
        {
            continue;
        }
        automatic_targets(&package.join(directory), &mut entries)?;
    }
    entries.retain(|p| p.is_file() && p.extension().is_some_and(|e| e == "rs"));
    entries.sort();
    entries.dedup();
    Ok(entries)
}

fn automatic_targets(directory: &Path, entries: &mut Vec<PathBuf>) -> Result<(), String> {
    if directory.is_dir() {
        for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            entries.push(if path.is_dir() {
                path.join("main.rs")
            } else {
                path
            });
        }
    }
    Ok(())
}

fn declared_targets(
    package: &Path,
    manifest: &toml::de::DeTable<'_>,
    kind: &str,
    directory: &str,
    entries: &mut Vec<PathBuf>,
) {
    let Some(targets) = manifest.get(kind).and_then(|v| v.get_ref().as_array()) else {
        return;
    };
    for target in targets {
        let target = target.get_ref();
        if let Some(path) = target.get("path").and_then(|v| v.get_ref().as_str()) {
            entries.push(package.join(path));
        } else if let Some(name) = target.get("name").and_then(|v| v.get_ref().as_str()) {
            entries.push(package.join(directory).join(format!("{name}.rs")));
            entries.push(package.join(directory).join(name).join("main.rs"));
            let package_name = manifest
                .get("package")
                .and_then(|p| p.get_ref().get("name"))
                .and_then(|v| v.get_ref().as_str());
            if kind == "bin" && package_name == Some(name) {
                entries.push(package.join("src/main.rs"));
            }
        }
    }
}
