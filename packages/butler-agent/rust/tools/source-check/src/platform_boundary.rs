//! Operating-system specific code lives in `crates/butler-platform` only.
//!
//! Everywhere else, a construct is a violation when it selects code per
//! operating system (`cfg(unix)`, `cfg(windows)`, `cfg(target_os = ..)`,
//! `cfg!(..)`, `cfg_attr(..)`), reaches an OS API (`std::os::unix`,
//! `std::os::windows`, `std::os::fd` in any import form, `nix`, `libc`,
//! `libproc`, `rustix`, renamed or not), reads the OS name
//! (`std::env::consts::OS`/`FAMILY`), spells raw permission bits (`0o600`)
//! or reads the home directory (`var_os("HOME")`, `var("USERPROFILE")`,
//! `env::home_dir`). In a package manifest, a target table that selects an
//! OS (a `cfg(..)` naming one, or a target triple) and a dependency on an OS
//! binding crate, however spelled or renamed, are violations too. Tests count
//! as well: they call the same platform API.
//!
//! Existing violations are ratcheted per package in [`BASELINE_FILE`]: each
//! file lists how many times each violation (by its compact spelling, not
//! its line) occurs, so one violation cannot be traded for another. A count
//! may only shrink: `--bless` lowers and removes entries but never raises or
//! adds one, so new OS-specific code outside `butler-platform` needs a
//! reviewed edit of the baseline.

mod scan;

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::function_length::{Mode, display, display_package, split_package};
use scan::Finding;

/// The crate that owns every operating-system specific construct.
const PLATFORM_PACKAGE: &str = "crates/butler-platform";
const BASELINE_FILE: &str = "os-specific-baseline.txt";
const BASELINE_HEADER: &str = "\
# OS-specific code outside crates/butler-platform, ratcheted by tools/source-check.
# FILE<TAB>COUNT<TAB>CODE: how often each construct occurs in each file.
# Move code behind butler-platform and lower the counts: cargo run -p butler-source-check -- --bless .
# --bless never raises or adds an entry; new entries need review.
";

/// File relative to its package -> its OS-specific constructs.
type Found = BTreeMap<String, Vec<Finding>>;
/// `(file relative to its package, construct)` -> how often it occurs.
type Baseline = BTreeMap<(String, String), usize>;

pub(crate) fn check(root: &Path, sources: &[PathBuf], mode: Mode) -> Result<bool, String> {
    let workspace = workspace_packages(root)?;
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
        let findings = if name.ends_with(".rs") {
            scan::source(&contents)
        } else {
            scan::manifest(&contents, &workspace)
        }
        .map_err(|error| format!("cannot scan {}: {error}", file.display()))?;
        if !findings.is_empty() {
            found.insert(name, findings);
        }
    }

    let mut violations = 0;
    let mut total = 0;
    for (package, found) in &packages {
        let path = root.join(package).join(BASELINE_FILE);
        let baseline = read_baseline(&path)?;
        if mode == Mode::Bless {
            let (blessed, refused) = bless(&display(package), found, &baseline);
            write_baseline(&path, &blessed)?;
            violations += refused;
        } else {
            violations += compare(&display(package), found, &baseline);
        }
        let count: usize = found.values().map(Vec::len).sum();
        total += count;
        if count > 0 {
            println!(
                "OS-SPECIFIC package={} files={} constructs={count}",
                display_package(package),
                found.len()
            );
        }
    }
    println!("OS-SPECIFIC outside={PLATFORM_PACKAGE} constructs={total} violations={violations}");
    Ok(violations > 0)
}

/// The renamed dependencies of the workspace manifest, when there is one.
fn workspace_packages(root: &Path) -> Result<BTreeMap<String, String>, String> {
    let path = root.join("Cargo.toml");
    match fs::read_to_string(&path) {
        Ok(contents) => scan::workspace_packages(&contents)
            .map_err(|error| format!("cannot scan {}: {error}", path.display())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(error) => Err(format!("cannot read {}: {error}", path.display())),
    }
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

/// How often each construct occurs in each file.
fn counts(found: &Found) -> Baseline {
    let mut counts = Baseline::new();
    for (file, findings) in found {
        for finding in findings {
            *counts
                .entry((file.clone(), finding.code.clone()))
                .or_default() += 1;
        }
    }
    counts
}

/// The lines of `file` where `code` occurs.
fn lines(found: &Found, file: &str, code: &str) -> String {
    found
        .get(file)
        .into_iter()
        .flatten()
        .filter(|finding| finding.code == code)
        .map(|finding| finding.line.to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

fn compare(package: &str, found: &Found, baseline: &Baseline) -> usize {
    let current = counts(found);
    let mut violations = 0;
    let mut report = |file: &str, message: String| {
        eprintln!("OS-SPECIFIC ERROR {package}{file}: {message}");
        violations += 1;
    };
    for ((file, code), &count) in &current {
        let at = lines(found, file, code);
        match baseline.get(&(file.clone(), code.clone())) {
            None => report(file, format!("`{code}` on line {at}; use butler-platform")),
            Some(&allowed) if count > allowed => report(
                file,
                format!("`{code}` {count} times (lines {at}) grew past baseline {allowed}"),
            ),
            Some(&allowed) if count < allowed => report(
                file,
                format!("`{code}` {count} times, baseline {allowed}; ratchet it with --bless"),
            ),
            Some(_) => {}
        }
    }
    for (file, code) in baseline.keys().filter(|key| !current.contains_key(*key)) {
        report(file, format!("`{code}` is gone; remove it with --bless"));
    }
    violations
}

/// The baseline `--bless` writes, and how many constructs it refused: each
/// entry lowered to its current count and gone entries dropped. It never
/// raises or adds an entry, so new or grown code keeps failing.
fn bless(package: &str, found: &Found, baseline: &Baseline) -> (Baseline, usize) {
    let mut blessed = Baseline::new();
    let mut refused = 0;
    for (key, count) in counts(found) {
        let allowed = baseline.get(&key).copied().unwrap_or(0);
        if count > allowed {
            let (file, code) = &key;
            eprintln!(
                "OS-SPECIFIC ERROR {package}{file}: `{code}` {count} times, baseline {allowed}; \
                 --bless only lowers counts, use butler-platform"
            );
            refused += 1;
        }
        if allowed > 0 {
            blessed.insert(key, count.min(allowed));
        }
    }
    (blessed, refused)
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
        let mut fields = line.splitn(3, '\t');
        let (Some(file), Some(count), Some(code)) = (fields.next(), fields.next(), fields.next())
        else {
            return Err(format!(
                "{}:{}: expected FILE<TAB>COUNT<TAB>CODE",
                path.display(),
                index + 1
            ));
        };
        let count = count
            .parse()
            .map_err(|error| format!("{}:{}: {error}", path.display(), index + 1))?;
        baseline.insert((file.to_owned(), code.to_owned()), count);
    }
    Ok(baseline)
}

fn write_baseline(path: &Path, baseline: &Baseline) -> Result<(), String> {
    if baseline.is_empty() {
        return match fs::remove_file(path) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => {
                Err(format!("cannot remove {}: {error}", path.display()))
            }
            _ => Ok(()),
        };
    }
    let mut contents = BASELINE_HEADER.to_owned();
    for ((file, code), count) in baseline {
        contents.push_str(&format!("{file}\t{count}\t{code}\n"));
    }
    fs::write(path, contents).map_err(|error| format!("cannot write {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::{Baseline, Found, bless, compare, scan::Finding};

    fn found(items: &[(&str, &[(usize, &str)])]) -> Found {
        items
            .iter()
            .map(|(file, findings)| {
                let findings = findings
                    .iter()
                    .map(|(line, code)| Finding {
                        line: *line,
                        code: (*code).to_owned(),
                    })
                    .collect();
                ((*file).to_owned(), findings)
            })
            .collect()
    }

    fn baseline(items: &[(&str, &str, usize)]) -> Baseline {
        items
            .iter()
            .map(|(file, code, count)| (((*file).to_owned(), (*code).to_owned()), *count))
            .collect()
    }

    #[test]
    fn ratchet_fails_new_grown_shrunk_and_stale_constructs() {
        let allowed = baseline(&[
            ("kept.rs", "cfg(unix)", 2),
            ("grown.rs", "0o600", 1),
            ("shrunk.rs", "cfg(windows)", 3),
            ("gone.rs", "libc::getpid", 1),
        ]);
        let current = found(&[
            ("kept.rs", &[(1, "cfg(unix)"), (2, "cfg(unix)")]),
            ("grown.rs", &[(4, "0o600"), (5, "0o600")]),
            ("shrunk.rs", &[(7, "cfg(windows)")]),
            ("new.rs", &[(9, "nix::unistd::getpid")]),
        ]);
        assert_eq!(compare("", &current, &allowed), 4);
        // Moving a construct to another line is not a change.
        let moved = found(&[("kept.rs", &[(30, "cfg(unix)"), (80, "cfg(unix)")])]);
        assert_eq!(
            compare("", &moved, &baseline(&[("kept.rs", "cfg(unix)", 2)])),
            0
        );
    }

    #[test]
    fn ratchet_fails_a_construct_traded_for_another() {
        let allowed = baseline(&[("a.rs", "cfg(unix)", 1), ("a.rs", "0o600", 1)]);
        let traded = found(&[("a.rs", &[(1, "cfg(unix)"), (2, "nix::unistd::getpid")])]);
        // `0o600` is gone and `nix::unistd::getpid` is new: both fail.
        assert_eq!(compare("", &traded, &allowed), 2);
    }

    #[test]
    fn bless_lowers_and_drops_entries_but_never_raises_or_adds_one() {
        let allowed = baseline(&[
            ("a.rs", "cfg(unix)", 3),
            ("a.rs", "0o600", 1),
            ("b.rs", "libc::getpid", 1),
        ]);
        let current = found(&[
            ("a.rs", &[(1, "cfg(unix)"), (2, "0o600"), (3, "0o600")]),
            ("c.rs", &[(1, "nix::unistd::getpid")]),
        ]);
        let (blessed, refused) = bless("", &current, &allowed);
        assert_eq!(refused, 2);
        assert_eq!(
            blessed,
            baseline(&[("a.rs", "cfg(unix)", 1), ("a.rs", "0o600", 1)])
        );
        // What bless refused still fails the check.
        assert_eq!(compare("", &current, &blessed), 2);
    }
}
