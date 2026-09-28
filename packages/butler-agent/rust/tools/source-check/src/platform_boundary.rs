//! Operating-system specific code lives in `crates/butler-platform` only.
//!
//! Everywhere else, a line is a violation when it selects code per operating
//! system (`cfg(unix)`, `cfg(windows)`, `cfg(target_os = ..)`, `cfg!(..)`,
//! `cfg_attr(..)`), reaches an OS API (`std::os::unix`, `std::os::windows`,
//! `std::os::fd`, `nix`, `libc`, `libproc`, `rustix`), spells raw permission
//! bits (`0o600`) or reads the home directory (`var_os("HOME")`,
//! `var("USERPROFILE")`, `env::home_dir`). In a package manifest, a
//! `[target.'cfg(..)']` table that selects an OS and an OS binding crate are
//! violations too. Tests count as well: they call the same platform API.
//!
//! Existing violations are ratcheted per package in [`BASELINE_FILE`]: the
//! number of violating lines of each file may only shrink. A shrunk or
//! removed entry fails until `--bless` records it, so the baseline burns down
//! as code moves behind `butler-platform`.

mod scan;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::function_length::{Mode, display, display_package, split_package};

/// The crate that owns every operating-system specific line.
const PLATFORM_PACKAGE: &str = "crates/butler-platform";
const BASELINE_FILE: &str = "os-specific-baseline.txt";
const BASELINE_HEADER: &str = "\
# Lines of OS-specific code outside crates/butler-platform, ratcheted by tools/source-check.
# Move them behind butler-platform and regenerate: cargo run -p butler-source-check -- --bless .
# Entries may only shrink or disappear; new entries need review.
";

/// File relative to its package -> its violating lines.
type Found = BTreeMap<String, BTreeSet<usize>>;
/// File relative to its package -> the number of violating lines allowed.
type Baseline = BTreeMap<String, usize>;

pub(crate) fn check(root: &Path, sources: &[PathBuf], mode: Mode) -> Result<bool, String> {
    let mut packages = BTreeMap::<PathBuf, Found>::new();
    for file in sources.iter().cloned().chain(manifests(root)?) {
        let relative = file.strip_prefix(root).unwrap_or(&file);
        let (package, name) = split_package(relative);
        if package == Path::new(PLATFORM_PACKAGE) {
            continue;
        }
        let found = packages.entry(package).or_default();
        let contents = fs::read_to_string(&file)
            .map_err(|error| format!("cannot read {}: {error}", file.display()))?;
        let lines = if name.ends_with(".rs") {
            scan::source(&contents)
                .map_err(|error| format!("cannot tokenize {}: {error}", file.display()))?
        } else {
            scan::manifest(&contents)
        };
        if !lines.is_empty() {
            found.insert(name, lines);
        }
    }

    let mut violations = 0;
    let mut total = 0;
    for (package, found) in &packages {
        let path = root.join(package).join(BASELINE_FILE);
        if mode == Mode::Bless {
            write_baseline(&path, found)?;
        } else {
            violations += compare(&display(package), found, &read_baseline(&path)?);
        }
        let lines: usize = found.values().map(BTreeSet::len).sum();
        total += lines;
        if lines > 0 {
            println!(
                "OS-SPECIFIC package={} files={} lines={lines}",
                display_package(package),
                found.len()
            );
        }
    }
    println!("OS-SPECIFIC outside={PLATFORM_PACKAGE} lines={total} violations={violations}");
    Ok(violations > 0)
}

/// The `Cargo.toml` of every package under `crates/` and `tools/`.
fn manifests(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut manifests = Vec::new();
    for group in ["crates", "tools"] {
        let directory = root.join(group);
        if !directory.is_dir() {
            continue;
        }
        let entries = fs::read_dir(&directory)
            .map_err(|error| format!("cannot read {}: {error}", directory.display()))?;
        for entry in entries {
            let entry =
                entry.map_err(|error| format!("cannot read {}: {error}", directory.display()))?;
            let manifest = entry.path().join("Cargo.toml");
            if manifest.is_file() {
                manifests.push(manifest);
            }
        }
    }
    manifests.sort();
    Ok(manifests)
}

fn compare(package: &str, found: &Found, baseline: &Baseline) -> usize {
    let mut violations = 0;
    let mut report = |file: &str, message: String| {
        eprintln!("OS-SPECIFIC ERROR {package}{file}: {message}");
        violations += 1;
    };
    for (file, lines) in found {
        let count = lines.len();
        let at = lines
            .iter()
            .map(usize::to_string)
            .collect::<Vec<_>>()
            .join(", ");
        match baseline.get(file) {
            None => report(
                file,
                format!("OS-specific code on lines {at}; use butler-platform"),
            ),
            Some(&allowed) if count > allowed => report(
                file,
                format!("{count} OS-specific lines ({at}) grew past baseline {allowed}"),
            ),
            Some(&allowed) if count < allowed => report(
                file,
                format!("{count} OS-specific lines, baseline {allowed}; ratchet it with --bless"),
            ),
            Some(_) => {}
        }
    }
    for file in baseline.keys().filter(|file| !found.contains_key(*file)) {
        report(
            file,
            "no OS-specific code left; remove it with --bless".to_owned(),
        );
    }
    violations
}

fn read_baseline(path: &Path) -> Result<Baseline, String> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Baseline::new()),
        Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
    };
    let mut baseline = Baseline::new();
    for (index, line) in contents.lines().enumerate() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut fields = line.split('\t');
        let (Some(file), Some(lines), None) = (fields.next(), fields.next(), fields.next()) else {
            return Err(format!(
                "{}:{}: expected FILE<TAB>LINES",
                path.display(),
                index + 1
            ));
        };
        let lines = lines
            .parse()
            .map_err(|error| format!("{}:{}: {error}", path.display(), index + 1))?;
        baseline.insert(file.to_owned(), lines);
    }
    Ok(baseline)
}

fn write_baseline(path: &Path, found: &Found) -> Result<(), String> {
    if found.is_empty() {
        return match fs::remove_file(path) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => {
                Err(format!("cannot remove {}: {error}", path.display()))
            }
            _ => Ok(()),
        };
    }
    let mut contents = BASELINE_HEADER.to_owned();
    for (file, lines) in found {
        contents.push_str(&format!("{file}\t{}\n", lines.len()));
    }
    fs::write(path, contents).map_err(|error| format!("cannot write {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::{Baseline, Found, compare};

    fn found(items: &[(&str, &[usize])]) -> Found {
        items
            .iter()
            .map(|(file, lines)| {
                (
                    (*file).to_owned(),
                    lines.iter().copied().collect::<BTreeSet<_>>(),
                )
            })
            .collect()
    }

    fn baseline(items: &[(&str, usize)]) -> Baseline {
        items
            .iter()
            .map(|(file, lines)| ((*file).to_owned(), *lines))
            .collect()
    }

    #[test]
    fn ratchet_fails_new_grown_shrunk_and_stale_files() {
        let allowed = baseline(&[
            ("kept.rs", 2),
            ("grown.rs", 1),
            ("shrunk.rs", 3),
            ("gone.rs", 1),
        ]);
        let current = found(&[
            ("kept.rs", &[1, 2]),
            ("grown.rs", &[4, 5]),
            ("shrunk.rs", &[7]),
            ("new.rs", &[9]),
        ]);
        assert_eq!(compare("", &current, &allowed), 4);
        assert_eq!(
            compare(
                "",
                &found(&[("kept.rs", &[3, 8])]),
                &baseline(&[("kept.rs", 2)])
            ),
            0
        );
    }
}
