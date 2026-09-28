//! Non-E2E test ratchet. Behaviour is tested end to end in `crates/butler-e2e`;
//! a test function anywhere else (`#[test]`, `#[tokio::test]`, ..) counts
//! against its package's line in [`BASELINE_FILE`], and the counts may only
//! shrink. A test outside the E2E harness also names why it cannot be an E2E
//! scenario with a marker comment directly above it (among its doc comments
//! and attributes):
//!
//! ```text
//! // test-category: format-pin
//! ```
//!
//! The categories are [`CATEGORIES`]. Unmarked tests are the ones still
//! waiting for E2E coverage; their count may only shrink as well, so a new
//! test needs a marker and a free slot. A shrunk count fails until the
//! baseline is regenerated with `--bless`, which never raises a count.

mod scan;

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use crate::function_length::Mode;

const BASELINE_FILE: &str = "source-check-tests.txt";
/// The E2E harness: its tests are the scenarios this ratchet points to.
const E2E_PACKAGE: &str = "crates/butler-e2e";
/// Why a test is not an E2E scenario: deterministic concurrency race,
/// security boundary, table-driven pure logic, persisted/wire format pin.
pub(crate) const CATEGORIES: &[&str] = &["race", "security", "pure-logic", "format-pin"];
const BASELINE_HEADER: &str = "\
# Non-E2E test functions per package, ratcheted by tools/source-check.
# Cover behaviour with E2E scenarios (crates/butler-e2e) first. A test kept
# outside them needs a `// test-category: race|security|pure-logic|format-pin`
# marker. Counts may only shrink; after deleting tests regenerate with
#   cargo run -p butler-source-check -- --bless .
# package<TAB>tests<TAB>unmarked
";

/// Test functions of one package and how many of them carry no marker.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Counts {
    tests: usize,
    unmarked: usize,
}

type Packages = BTreeMap<String, Counts>;

pub(crate) fn check(root: &Path, sources: &[PathBuf], mode: Mode) -> Result<bool, String> {
    let mut found = Packages::new();
    let mut violations = 0;
    for source in sources {
        let relative = source.strip_prefix(root).unwrap_or(source);
        let Some(package) = package(relative) else {
            continue;
        };
        if package == E2E_PACKAGE {
            continue;
        }
        let contents = fs::read_to_string(source)
            .map_err(|error| format!("cannot read {}: {error}", source.display()))?;
        let file = scan::tests(&contents)
            .map_err(|error| format!("invalid Rust syntax in {}: {error}", source.display()))?;
        for (line, problem) in &file.problems {
            eprintln!(
                "TESTS ERROR {}:{line} {problem}",
                relative.to_string_lossy().replace('\\', "/")
            );
            violations += 1;
        }
        let counts = found.entry(package).or_default();
        counts.tests += file.tests;
        counts.unmarked += file.unmarked;
    }

    let path = root.join(BASELINE_FILE);
    let baseline = read_baseline(&path)?;
    if mode == Mode::Bless {
        let grown = compare(&found, &baseline, true);
        if grown == 0 {
            write_baseline(&path, &found)?;
        }
        violations += grown;
    } else {
        violations += compare(&found, &baseline, false);
    }
    let mut total = Counts::default();
    for (package, counts) in &found {
        println!(
            "TESTS package={package} tests={} unmarked={}",
            counts.tests, counts.unmarked
        );
        total.tests += counts.tests;
        total.unmarked += counts.unmarked;
    }
    println!(
        "TESTS tests={} unmarked={} violations={violations}",
        total.tests, total.unmarked
    );
    Ok(violations > 0)
}

/// `crates/<name>` or `tools/<name>` for a file inside that package.
fn package(relative: &Path) -> Option<String> {
    let parts: Vec<_> = relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => part.to_str(),
            _ => None,
        })
        .collect();
    match parts.as_slice() {
        [group @ ("crates" | "tools"), name, _, ..] => Some(format!("{group}/{name}")),
        _ => None,
    }
}

/// Reports every package whose counts differ from the baseline; with
/// `growth_only` (blessing) only counts that grew.
fn compare(found: &Packages, baseline: &Packages, growth_only: bool) -> usize {
    let mut violations = 0;
    let packages: std::collections::BTreeSet<_> = found.keys().chain(baseline.keys()).collect();
    for package in packages {
        let found = found.get(package).copied().unwrap_or_default();
        let allowed = baseline.get(package).copied().unwrap_or_default();
        let mut report = |message: String| {
            eprintln!("TESTS ERROR {package}: {message}");
            violations += 1;
        };
        if found.tests > allowed.tests {
            report(format!(
                "{} non-E2E tests, baseline {}; cover the behaviour with an E2E scenario or replace an existing test",
                found.tests, allowed.tests
            ));
        }
        if found.unmarked > allowed.unmarked {
            report(format!(
                "{} tests without a `// test-category:` marker, baseline {}; mark the new test",
                found.unmarked, allowed.unmarked
            ));
        }
        if !growth_only
            && found != allowed
            && found.tests <= allowed.tests
            && found.unmarked <= allowed.unmarked
        {
            report(format!(
                "{} tests ({} unmarked), baseline {} ({}); ratchet it with --bless",
                found.tests, found.unmarked, allowed.tests, allowed.unmarked
            ));
        }
    }
    violations
}

fn read_baseline(path: &Path) -> Result<Packages, String> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Packages::new()),
        Err(error) => return Err(format!("cannot read {}: {error}", path.display())),
    };
    let mut packages = Packages::new();
    for (index, line) in contents.lines().enumerate() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let invalid = || {
            format!(
                "{}:{}: expected PACKAGE<TAB>TESTS<TAB>UNMARKED",
                path.display(),
                index + 1
            )
        };
        let mut fields = line.split('\t');
        let (Some(package), Some(tests), Some(unmarked), None) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            return Err(invalid());
        };
        let (Ok(tests), Ok(unmarked)) = (tests.parse(), unmarked.parse()) else {
            return Err(invalid());
        };
        packages.insert(package.to_owned(), Counts { tests, unmarked });
    }
    Ok(packages)
}

fn write_baseline(path: &Path, packages: &Packages) -> Result<(), String> {
    let mut contents = BASELINE_HEADER.to_owned();
    for (package, counts) in packages {
        if counts.tests > 0 {
            contents.push_str(&format!(
                "{package}\t{}\t{}\n",
                counts.tests, counts.unmarked
            ));
        }
    }
    fs::write(path, contents).map_err(|error| format!("cannot write {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{Counts, Packages, compare, package};

    fn packages(rows: &[(&str, usize, usize)]) -> Packages {
        rows.iter()
            .map(|(name, tests, unmarked)| {
                (
                    (*name).to_owned(),
                    Counts {
                        tests: *tests,
                        unmarked: *unmarked,
                    },
                )
            })
            .collect()
    }

    /// Pure-logic table: packages are `crates/*` and `tools/*`, and the
    /// ratchet fails grown, newly unmarked and shrunk counts (blessing reports
    /// growth only).
    // test-category: pure-logic
    #[test]
    fn ratchet_fails_growth_new_unmarked_tests_and_unblessed_shrinkage() {
        for (path, expected) in [
            ("crates/butler-turn/src/lib.rs", Some("crates/butler-turn")),
            (
                "crates/butler-ledger/tests/wire_formats.rs",
                Some("crates/butler-ledger"),
            ),
            ("tools/source-check/src/main.rs", Some("tools/source-check")),
            ("build.rs", None),
        ] {
            assert_eq!(package(Path::new(path)).as_deref(), expected, "{path}");
        }

        let baseline = packages(&[
            ("kept", 5, 2),
            ("grown", 5, 2),
            ("marked", 5, 2),
            ("shrunk", 5, 2),
            ("gone", 1, 1),
        ]);
        let found = packages(&[
            ("kept", 5, 2),
            ("grown", 6, 2),
            ("marked", 5, 3),
            ("shrunk", 4, 1),
            ("new", 1, 0),
        ]);
        // (growth only, violations): grown, new unmarked, the new package; plus shrunk and gone
        for (growth_only, violations) in [(true, 3), (false, 5)] {
            assert_eq!(
                compare(&found, &baseline, growth_only),
                violations,
                "{growth_only}"
            );
        }
        assert_eq!(compare(&baseline, &baseline, false), 0);
    }
}
