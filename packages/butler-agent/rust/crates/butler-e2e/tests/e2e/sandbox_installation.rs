//! Installation isolation and the unsynced fallback, through the real harness.
use butler_e2e::e2e::{
    HarnessError,
    agent::Launch,
    binary::agent_binary,
    installation::{self, Access},
    sandbox::Sandbox,
};
use std::{fs, io, path::Path, time::Instant};

#[test]
fn immutable_installation_rejects_writes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut sandbox = Sandbox::new("INSTALL-IMMUTABLE")?;
    let source = agent_binary()?;
    let probe = sandbox.root.join("link-probe");
    if butler_platform::command_sandbox::FixtureInstallation::HARD_LINKS
        && fs::hard_link(&source, &probe).is_ok()
    {
        assert!(butler_platform::secure_fs::same_file(
            &source,
            &sandbox.binary
        )?);
        fs::remove_file(probe)?;
    }
    for path in [
        &sandbox.binary,
        &sandbox.resources.join("templates/eol.template.md"),
        &sandbox.resources.join("app-client/dist/index.html"),
    ] {
        assert!(
            fs::metadata(path)?.permissions().readonly(),
            "{}",
            path.display()
        );
        assert!(
            fs::OpenOptions::new().write(true).open(path).is_err(),
            "{}",
            path.display()
        );
    }
    assert_complete_resources(
        &butler_e2e::e2e::binary::resource_source(),
        &sandbox.resources,
    )?;
    assert_version(&sandbox)?;
    sandbox.mark_success();
    Ok(())
}

#[test]
fn mutable_installation_has_independent_writable_files() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut sandbox = Sandbox::mutates_installation("INSTALL-MUTABLE")?;
    let source = agent_binary()?;
    assert!(!butler_platform::secure_fs::same_file(
        &source,
        &sandbox.binary
    )?);
    let original = fs::metadata(&source)?.len();
    fs::OpenOptions::new()
        .write(true)
        .open(&sandbox.binary)?
        .set_len(7)?;
    assert_eq!(fs::metadata(&source)?.len(), original);
    let source = butler_e2e::e2e::binary::resource_source().join("templates/eol.template.md");
    let bytes = fs::read(&source)?;
    let target = sandbox.resources.join("templates/eol.template.md");
    assert!(!butler_platform::secure_fs::same_file(&source, &target)?);
    fs::write(target, b"private")?;
    assert_eq!(fs::read(source)?, bytes);
    sandbox.mark_success();
    Ok(())
}

fn unavailable(_: &Path, _: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "filesystem operation unavailable",
    ))
}

#[test]
fn failed_fast_paths_publish_a_complete_runnable_fallback() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut sandbox = Sandbox::mutates_installation("INSTALL-FALLBACK")?;
    let source = agent_binary()?;
    installation::install_with(
        &source,
        &sandbox.binary,
        Access::Immutable,
        unavailable,
        |_, path| {
            fs::write(path, b"partial kernel copy")?;
            unavailable(&source, path)
        },
    )?;
    assert!(!butler_platform::secure_fs::same_file(
        &source,
        &sandbox.binary
    )?);
    assert_eq!(
        fs::metadata(&source)?.len(),
        fs::metadata(&sandbox.binary)?.len()
    );
    assert_eq!(
        butler_e2e::e2e::install_fixture::file_sha256(&source)?,
        butler_e2e::e2e::install_fixture::file_sha256(&sandbox.binary)?
    );
    assert_complete_resources(
        &butler_e2e::e2e::binary::resource_source(),
        &sandbox.resources,
    )?;
    assert_version(&sandbox)?;
    sandbox.mark_success();
    Ok(())
}

#[test]
fn failed_link_uses_an_independent_readonly_kernel_copy() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut sandbox = Sandbox::new("INSTALL-KERNEL-COPY")?;
    let source = sandbox.root.join("source");
    let target = sandbox.root.join("target");
    fs::write(&source, b"complete resource")?;
    installation::install_with(
        &source,
        &target,
        Access::Immutable,
        unavailable,
        |from, to| fs::copy(from, to).map(|_| ()),
    )?;
    assert!(!butler_platform::secure_fs::same_file(&source, &target)?);
    assert_eq!(fs::read(&target)?, b"complete resource");
    assert!(fs::OpenOptions::new().write(true).open(target).is_err());
    sandbox.mark_success();
    Ok(())
}

fn assert_version(sandbox: &Sandbox) -> Result<(), HarnessError> {
    let output = Launch::new(sandbox)?.command().arg("--version").output()?;
    assert!(output.status.success(), "{output:?}");
    Ok(())
}

/// Run alone with --nocapture --test-threads=1 for setup-only I/O measurements.
#[test]
fn sandbox_setup_measurement() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    if !butler_e2e::e2e::config::flag("BUTLER_E2E_PERF") {
        return Ok(());
    }
    agent_binary()?; // Exclude optional compilation from setup measurements.
    for count in [1, 8] {
        let before = butler_platform::process_control::sample_usage(std::process::id())?;
        let started = Instant::now();
        let sandboxes = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..count)
                .map(|_| {
                    scope.spawn(|| {
                        let started = Instant::now();
                        Sandbox::new("INSTALL-MEASURE").map(|sandbox| (sandbox, started.elapsed()))
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().map_err(|_| io::Error::other("setup panicked"))?)
                .collect::<Result<Vec<_>, HarnessError>>()
        })?;
        let elapsed = started.elapsed();
        let after = butler_platform::process_control::sample_usage(std::process::id())?;
        let writes = before
            .zip(after)
            .map(|(a, b)| b.write_bytes.saturating_sub(a.write_bytes));
        eprintln!("installation: scenarios={count} wall={elapsed:?} write_bytes={writes:?}");
        for (mut sandbox, elapsed) in sandboxes {
            assert_eq!(
                fs::metadata(&sandbox.binary)?.len(),
                fs::metadata(agent_binary()?)?.len()
            );
            assert!(
                sandbox
                    .resources
                    .join("templates/eol.template.md")
                    .is_file()
            );
            assert_complete_resources(
                &butler_e2e::e2e::binary::resource_source(),
                &sandbox.resources,
            )?;
            eprintln!("installation: scenario_setup={elapsed:?}");
            sandbox.mark_success();
        }
    }
    Ok(())
}

#[test]
fn immutable_installation_resolves_relative_source_aliases() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::command_sandbox::FixtureInstallation::HARD_LINKS,
        "hard-link source aliases"
    );
    let mut sandbox = Sandbox::new("INSTALL-SOURCE-ALIAS")?;
    let input = sandbox.root.join("input");
    fs::create_dir(&input)?;
    fs::write(input.join("payload"), b"complete resource")?;
    butler_platform::secure_fs::symlink(Path::new("payload"), &input.join("alias"))?;
    let target = sandbox.resources.join("aliased-resource");
    installation::install(&input.join("alias"), &target, Access::Immutable)?;
    assert!(fs::symlink_metadata(&target)?.is_file());
    assert_eq!(fs::read(&target)?, b"complete resource");
    assert!(fs::metadata(&target)?.permissions().readonly());
    assert!(fs::OpenOptions::new().write(true).open(&target).is_err());
    sandbox.mark_success();
    Ok(())
}

fn assert_complete_resources(source: &Path, target: &Path) -> Result<(), HarnessError> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let installed = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            assert_complete_resources(&entry.path(), &installed)?;
        } else if entry.file_type()?.is_file() {
            assert_eq!(
                fs::read(entry.path())?,
                fs::read(&installed)?,
                "{}",
                installed.display()
            );
        }
    }
    Ok(())
}
