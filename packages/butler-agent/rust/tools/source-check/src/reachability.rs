//! Reject production source files outside the declared module trees.
use crate::{
    function_length::{canonical, split_package},
    modules, targets,
};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

pub(crate) fn unreached(
    root: &Path,
    sources: &[PathBuf],
    production: &BTreeSet<PathBuf>,
) -> Result<Vec<PathBuf>, String> {
    let mut test_files = BTreeSet::new();
    for entry in targets::workspace_roots(root)? {
        for module in modules::load_skipping(&entry, |_| false)? {
            let path = canonical(&module.file)?;
            if !production.contains(&path) {
                test_files.insert(path);
            }
        }
    }
    let mut missing = Vec::new();
    for source in sources {
        let relative = source.strip_prefix(root).unwrap_or(source);
        let (package, file) = split_package(relative);
        if targets::test_package(&root.join(&package)) || !file.starts_with("src/") {
            continue;
        }
        if !root.join(package).join("Cargo.toml").is_file() {
            continue;
        }
        if Path::new(&file).components().any(|part| {
            matches!(
                part.as_os_str().to_str(),
                Some("test" | "tests" | "benches")
            )
        }) {
            continue;
        }
        let path = canonical(source)?;
        if production.contains(&path) || test_files.contains(&path) {
            continue;
        }
        let contents = fs::read_to_string(source).map_err(|e| e.to_string())?;
        let parsed = syn::parse_file(&contents).map_err(|e| e.to_string())?;
        if !modules::test_only(&parsed.attrs) {
            missing.push(relative.to_owned());
        }
    }
    Ok(missing)
}

pub(crate) fn check(
    root: &Path,
    sources: &[PathBuf],
    production: &BTreeSet<PathBuf>,
) -> Result<usize, String> {
    let missing = unreached(root, sources, production)?;
    for file in &missing {
        eprintln!("UNREACHED {}", file.display());
    }
    Ok(missing.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    // test-category: pure-logic
    #[test]
    fn macro_module_and_orphan_are_unreached_but_targets_and_paths_are_reached() {
        let root = std::env::temp_dir().join(format!("source-reachability-{}", std::process::id()));
        let package = root.join("crates/sample");
        fs::create_dir_all(package.join("src/portable")).unwrap();
        fs::create_dir_all(package.join("src/bin")).unwrap();
        fs::create_dir_all(package.join("examples")).unwrap();
        fs::write(
            package.join("Cargo.toml"),
            "[package]\nname='sample'\nversion='0.1.0'\nautobins=false\n[[bin]]\nname='sample'\n[[bin]]\nname='worker'\n",
        )
        .unwrap();
        let files = [
            (
                "src/lib.rs",
                "macro_rules! m { () => { mod helper; } } m!();\n#[path=\"portable/entry.rs\"] mod portable;\n#[cfg(test)] mod checks;",
            ),
            ("src/helper.rs", "fn long() {}"),
            ("src/orphan.rs", "fn orphan() {}"),
            ("src/portable/entry.rs", "#[path=\"child.rs\"] mod child;"),
            ("src/portable/child.rs", "fn child() {}"),
            ("src/checks.rs", "#[test] fn check() {}"),
            ("src/main.rs", "fn main() {}"),
            ("src/bin/worker.rs", "fn main() {}"),
            ("build.rs", "fn main() {}"),
            ("examples/demo.rs", "fn main() {}"),
        ];
        let sources: Vec<_> = files
            .iter()
            .map(|(path, text)| {
                let path = package.join(path);
                fs::write(&path, text).unwrap();
                path
            })
            .collect();
        let production = crate::function_length::production_files(&root, modules::load).unwrap();
        for path in [
            "src/main.rs",
            "src/bin/worker.rs",
            "build.rs",
            "examples/demo.rs",
            "src/portable/child.rs",
        ] {
            assert!(
                production.contains(&canonical(&package.join(path)).unwrap()),
                "{path}"
            );
        }
        assert_eq!(
            unreached(&root, &sources, &production).unwrap(),
            [
                PathBuf::from("crates/sample/src/helper.rs"),
                PathBuf::from("crates/sample/src/orphan.rs")
            ]
        );
        fs::remove_dir_all(root).unwrap();
    }
}
