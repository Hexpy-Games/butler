//! Function length ratchet for production code: a production function body
//! over [`MAX_FUNCTION_LINES`] lines fails unless its package's baseline lists
//! it at exactly its current length. Baselines only shrink: a longer function
//! fails, and a shorter or removed one fails until the baseline is regenerated
//! with `--bless`.
//!
//! Test code is not measured: `#[cfg(test)]` modules and items, test
//! functions, integration tests and the [`TEST_PACKAGES`].

mod measure;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use crate::modules;

pub(crate) const MAX_FUNCTION_LINES: usize = 80;
/// Packages that hold only test code: the E2E harness and shared test support.
const TEST_PACKAGES: &[&str] = &["crates/butler-e2e", "crates/butler-test-support"];
const BASELINE_FILE: &str = "source-check-baseline.txt";
const BASELINE_HEADER: &str = "\
# Production functions over 80 lines, ratcheted by tools/source-check.
# Split a function and regenerate: cargo run -p butler-source-check -- --bless .
# Entries may only shrink or disappear; new entries need review.
";

/// `(file relative to the package, qualified function name)` -> line count.
type Entries = BTreeMap<(String, String), usize>;

/// Whether this run checks the baselines or rewrites them to the current state.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    Check,
    Bless,
}

pub(crate) fn check(root: &Path, sources: &[PathBuf], mode: Mode) -> Result<bool, String> {
    let production = production_files(root)?;
    let mut packages = BTreeMap::<PathBuf, Entries>::new();
    for source in sources {
        let relative = source.strip_prefix(root).unwrap_or(source);
        let (package, file) = split_package(relative);
        let entries = packages.entry(package).or_default();
        if !production.contains(&canonical(source)?) {
            continue;
        }
        let contents = fs::read_to_string(source)
            .map_err(|error| format!("cannot read {}: {error}", source.display()))?;
        let functions = measure::functions(&contents)
            .map_err(|error| format!("invalid Rust syntax in {}: {error}", source.display()))?;
        for function in functions {
            if function.lines > MAX_FUNCTION_LINES {
                entries.insert((file.clone(), function.name), function.lines);
            }
        }
    }

    let mut violations = 0;
    for (package, found) in &packages {
        let path = root.join(package).join(BASELINE_FILE);
        if mode == Mode::Bless {
            write_baseline(&path, found)?;
        } else {
            violations += compare(&display(package), found, &read_baseline(&path)?);
        }
        println!(
            "FUNCTION-LENGTH package={} over_limit={}",
            display_package(package),
            found.len()
        );
    }
    println!("FUNCTION-LENGTH limit={MAX_FUNCTION_LINES} violations={violations}");
    Ok(violations > 0)
}

/// Canonical paths of the files production builds compile: the module trees
/// of every package's library, binaries and build script without its
/// `cfg(test)` modules, skipping the [`TEST_PACKAGES`].
fn production_files(root: &Path) -> Result<BTreeSet<PathBuf>, String> {
    let mut files = BTreeSet::new();
    for group in ["crates", "tools"] {
        for package in directories(&root.join(group))? {
            if TEST_PACKAGES.iter().any(|test| root.join(test) == package) {
                continue;
            }
            for entry in crate_roots(&package)? {
                for module in modules::load(&entry)? {
                    files.insert(canonical(&module.file)?);
                }
            }
        }
    }
    Ok(files)
}

/// The crate roots of one package: `src/lib.rs`, `src/main.rs`, `build.rs`
/// and every `src/bin` binary.
fn crate_roots(package: &Path) -> Result<Vec<PathBuf>, String> {
    let mut roots: Vec<PathBuf> = ["src/lib.rs", "src/main.rs", "build.rs"]
        .iter()
        .map(|file| package.join(file))
        .collect();
    let bin = package.join("src/bin");
    if bin.is_dir() {
        for path in sorted_entries(&bin)? {
            roots.push(if path.is_dir() {
                path.join("main.rs")
            } else {
                path
            });
        }
    }
    roots.retain(|root| root.is_file() && root.extension().is_some_and(|ext| ext == "rs"));
    Ok(roots)
}

/// The subdirectories of `directory`, or none when it does not exist.
fn directories(directory: &Path) -> Result<Vec<PathBuf>, String> {
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut paths = sorted_entries(directory)?;
    paths.retain(|path| path.is_dir());
    Ok(paths)
}

fn sorted_entries(directory: &Path) -> Result<Vec<PathBuf>, String> {
    let unreadable = |error: io::Error| format!("cannot read {}: {error}", directory.display());
    let mut paths = fs::read_dir(directory)
        .map_err(unreadable)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(unreadable)?;
    paths.sort();
    Ok(paths)
}

fn canonical(path: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|error| format!("cannot resolve {}: {error}", path.display()))
}

/// `crates/<name>/..` and `tools/<name>/..` belong to that package; anything
/// else to the workspace root.
fn split_package(relative: &Path) -> (PathBuf, String) {
    let parts: Vec<_> = relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => part.to_str(),
            _ => None,
        })
        .collect();
    match parts.as_slice() {
        [group @ ("crates" | "tools"), name, rest @ ..] if !rest.is_empty() => {
            ([group, name].iter().collect(), rest.join("/"))
        }
        _ => (PathBuf::new(), parts.join("/")),
    }
}

fn compare(package: &str, found: &Entries, baseline: &Entries) -> usize {
    let mut violations = 0;
    let mut report = |(file, name): &(String, String), message: String| {
        eprintln!("FUNCTION-LENGTH ERROR {package}{file} {name}: {message}");
        violations += 1;
    };
    for (key, &lines) in found {
        match baseline.get(key) {
            None => report(key, format!("{lines} lines exceed {MAX_FUNCTION_LINES}")),
            Some(&allowed) if lines > allowed => {
                report(key, format!("{lines} lines grew past baseline {allowed}"));
            }
            Some(&allowed) if lines < allowed => report(
                key,
                format!("{lines} lines, baseline {allowed}; ratchet it with --bless"),
            ),
            Some(_) => {}
        }
    }
    let stale: BTreeSet<_> = baseline
        .keys()
        .filter(|key| !found.contains_key(*key))
        .collect();
    for key in stale {
        report(
            key,
            "no longer over the limit; remove it with --bless".to_owned(),
        );
    }
    violations
}

fn read_baseline(path: &Path) -> Result<Entries, String> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Entries::new()),
        Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
    };
    let mut entries = Entries::new();
    for (index, line) in contents.lines().enumerate() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut fields = line.split('\t');
        let (Some(file), Some(name), Some(lines), None) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            return Err(format!(
                "{}:{}: expected FILE<TAB>FUNCTION<TAB>LINES",
                path.display(),
                index + 1
            ));
        };
        let lines = lines
            .parse()
            .map_err(|error| format!("{}:{}: {error}", path.display(), index + 1))?;
        entries.insert((file.to_owned(), name.to_owned()), lines);
    }
    Ok(entries)
}

fn write_baseline(path: &Path, entries: &Entries) -> Result<(), String> {
    if entries.is_empty() {
        return match fs::remove_file(path) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => {
                Err(format!("cannot remove {}: {error}", path.display()))
            }
            _ => Ok(()),
        };
    }
    let mut contents = BASELINE_HEADER.to_owned();
    for ((file, name), lines) in entries {
        contents.push_str(&format!("{file}\t{name}\t{lines}\n"));
    }
    fs::write(path, contents).map_err(|error| format!("cannot write {}: {error}", path.display()))
}

fn display(package: &Path) -> String {
    let package = package.to_string_lossy().replace('\\', "/");
    if package.is_empty() {
        package
    } else {
        format!("{package}/")
    }
}

fn display_package(package: &Path) -> String {
    let package = package.to_string_lossy().replace('\\', "/");
    if package.is_empty() {
        ".".to_owned()
    } else {
        package
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::{Entries, compare, split_package};

    fn entries(items: &[(&str, usize)]) -> Entries {
        items
            .iter()
            .map(|(name, lines)| (("src/lib.rs".to_owned(), (*name).to_owned()), *lines))
            .collect()
    }

    #[test]
    fn packages_are_crates_and_tools() {
        for (path, package, file) in [
            (
                "crates/butler-ledger/src/lib.rs",
                "crates/butler-ledger",
                "src/lib.rs",
            ),
            (
                "tools/source-check/src/main.rs",
                "tools/source-check",
                "src/main.rs",
            ),
            ("build.rs", "", "build.rs"),
        ] {
            assert_eq!(
                split_package(Path::new(path)),
                (PathBuf::from(package), file.to_owned())
            );
        }
    }

    #[test]
    fn ratchet_fails_new_grown_shrunk_and_stale_entries() {
        let baseline = entries(&[("kept", 90), ("grown", 90), ("shrunk", 90), ("gone", 90)]);
        let found = entries(&[("kept", 90), ("grown", 91), ("shrunk", 85), ("new", 81)]);
        assert_eq!(compare("", &found, &baseline), 4);
        assert_eq!(
            compare("", &entries(&[("kept", 90)]), &entries(&[("kept", 90)])),
            0
        );
    }
}
