//! The test tier belongs to the harness, including in fault builds.
use crate::function_length::{canonical, production_files};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) fn check(root: &Path, sources: &[PathBuf]) -> Result<bool, String> {
    let production = production_files(root, crate::modules::load)?;
    let mut violations = 0;
    for source in sources {
        let relative = source.strip_prefix(root).unwrap_or(source);
        if !production.contains(&canonical(source)?) {
            continue;
        }
        let text = fs::read_to_string(source).map_err(|error| error.to_string())?;
        for (line, _) in crate::e2e_hooks::tier_reads(&text).map_err(|error| error.to_string())? {
            eprintln!(
                "E2E TIER ERROR {}:{line}: tier input belongs in butler-e2e",
                relative.display()
            );
            violations += 1;
        }
    }
    println!("E2E TIER violations={violations}");
    Ok(violations > 0)
}

#[cfg(test)]
pub(crate) fn assert_tier_patterns() {
    for (source, count) in [
        (r#"fn product() { std::env::var("BUTLER_E2E_TIER"); }"#, 1),
        (
            r#"const KEY: &str = "BUTLER_E2E_TIER"; fn product() { std::env::var(KEY); }"#,
            1,
        ),
        (r#"fn product() { run("$env:BUTLER_E2E_TIER"); }"#, 1),
        (
            r#"#[cfg(feature = "e2e-fixtures")] fn fault() { std::env::var_os("BUTLER_E2E_TIER"); }"#,
            1,
        ),
        (
            r#"fn product() { env!("BUTLER_E2E_TIER"); option_env!("BUTLER_E2E_TIER"); }"#,
            2,
        ),
        (
            r#"#[cfg(test)] mod tests { fn helper() { std::env::var("BUTLER_E2E_TIER"); } }"#,
            0,
        ),
        (
            r#"#[test] fn test() { std::env::var("BUTLER_E2E_TIER"); }"#,
            0,
        ),
        (
            r#"fn product() { #[cfg(test)] let tier = std::env::var("BUTLER_E2E_TIER"); }"#,
            0,
        ),
        (
            r#"fn product() { std::env::var("BUTLER_E2E_IDLE_PROBE"); }"#,
            0,
        ),
        (r#"fn product() { std::env::var("BUTLER_E2E_TIERS"); }"#, 0),
        (
            r"// BUTLER_E2E_TIER
fn product() {}",
            0,
        ),
    ] {
        assert_eq!(
            crate::e2e_hooks::tier_reads(source).unwrap().len(),
            count,
            "{source}"
        );
    }
}
