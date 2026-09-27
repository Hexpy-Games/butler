//! Cassette hygiene (PROVIDER_CONFIG.md §4.2): every committed cassette was
//! written by the recorder (hashes match `meta.json`) and holds no secrets,
//! personal paths, account ids or canaries.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use std::fs;
use std::path::Path;

use butler_e2e::e2e::cassette::{self, load_from};
use butler_e2e::e2e::sanitize;

fn scenario_dirs(root: &Path, prefix: &str, out: &mut Vec<(String, std::path::PathBuf)>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = format!("{prefix}{}", entry.file_name().to_string_lossy());
        if path.join("meta.json").is_file() {
            out.push((name.clone(), path.clone()));
        }
        scenario_dirs(&path, &format!("{name}/"), out);
    }
}

#[test]
fn cassettes_are_recorder_written_and_sanitized() {
    let root = cassette::root();
    let mut dirs = Vec::new();
    scenario_dirs(&root, "", &mut dirs);
    let mut findings = Vec::new();
    for (name, dir) in &dirs {
        match load_from(dir, name) {
            Ok(loaded) => {
                if loaded.meta.recorded_at.is_empty() || loaded.meta.provider.is_empty() {
                    findings.push(format!("{name}: meta lacks provenance"));
                }
            }
            Err(error) => findings.push(format!("{name}: {error}")),
        }
        for entry in fs::read_dir(dir).unwrap().flatten() {
            let text = fs::read_to_string(entry.path()).unwrap_or_default();
            for finding in sanitize::lint(&text) {
                findings.push(format!(
                    "{name}/{}: {finding}",
                    entry.file_name().to_string_lossy()
                ));
            }
        }
    }
    assert!(
        findings.is_empty(),
        "cassette lint failed:\n{}",
        findings.join("\n")
    );
}
