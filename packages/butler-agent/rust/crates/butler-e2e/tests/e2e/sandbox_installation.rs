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
    let mut other = Sandbox::new("INSTALL-SHARED-SNAPSHOT")?;
    if butler_platform::command_sandbox::FixtureInstallation::HARD_LINKS {
        assert!(!butler_platform::secure_fs::same_file(
            &agent_binary()?,
            &sandbox.binary
        )?);
        assert!(butler_platform::secure_fs::same_file(
            &other.binary,
            &sandbox.binary
        )?);
    }
    other.mark_success();
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
    let source = agent_binary()?; // Exclude optional compilation from setup measurements.
    let mut binaries = vec![source.clone()];
    if let Some(helper) = butler_platform::command_sandbox::FixtureInstallation::command_helper() {
        binaries.push(source.with_file_name(helper));
    }
    let expected = binaries
        .iter()
        .map(|path| {
            Ok((
                path.file_name()
                    .ok_or_else(|| io::Error::other("missing file name"))?
                    .to_owned(),
                butler_e2e::e2e::install_fixture::file_sha256(path)?,
            ))
        })
        .collect::<Result<Vec<_>, HarnessError>>()?;
    if butler_platform::command_sandbox::FixtureInstallation::HARD_LINKS {
        let before = butler_platform::process_control::sample_usage(std::process::id())?;
        let started = Instant::now();
        drop(installation::snapshot::prepare()?);
        let elapsed = started.elapsed();
        let after = butler_platform::process_control::sample_usage(std::process::id())?;
        let writes = before
            .zip(after)
            .map(|(a, b)| b.write_bytes.saturating_sub(a.write_bytes));
        eprintln!("installation: snapshot={elapsed:?} write_bytes={writes:?}");
    }
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
            for (name, hash) in &expected {
                assert_eq!(
                    &butler_e2e::e2e::install_fixture::file_sha256(
                        &sandbox.install.join("bin").join(name)
                    )?,
                    hash
                );
            }
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
    let mut sandbox = Sandbox::mutates_installation("INSTALL-SOURCE-ALIAS")?;
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

#[test]
fn setup_and_teardown_preserve_source_modes_and_contents() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        butler_platform::command_sandbox::linux_test_host(),
        "Linux source isolation"
    );
    if !butler_e2e::e2e::config::flag("BUTLER_E2E_SOURCE_CHECK_CHILD") {
        return source_check_processes();
    }
    let binary = agent_binary()?;
    let mut sources = vec![binary.clone()];
    if let Some(helper) = butler_platform::command_sandbox::FixtureInstallation::command_helper() {
        sources.push(binary.with_file_name(helper));
    }
    source_files(&butler_e2e::e2e::binary::resource_source(), &mut sources)?;
    let before = source_state(&sources)?;
    let mut sandbox = Sandbox::new("INSTALL-SOURCE-UNCHANGED")?;
    assert_version(&sandbox)?;
    println!(
        "snapshot inode: {:?}",
        butler_platform::secure_fs::identity(&fs::metadata(&sandbox.binary)?).id
    );
    sandbox.mark_success();
    drop(sandbox);
    assert_eq!(
        source_state(&sources)?,
        before,
        "setup/teardown altered a source"
    );
    Ok(())
}

fn source_files(root: &Path, out: &mut Vec<std::path::PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            source_files(&entry.path(), out)?;
        } else if entry.file_type()?.is_file() {
            out.push(entry.path());
        }
    }
    Ok(())
}

fn source_state(
    paths: &[std::path::PathBuf],
) -> Result<Vec<(fs::Permissions, String)>, HarnessError> {
    paths
        .iter()
        .map(|path| {
            Ok((
                fs::metadata(path)?.permissions(),
                butler_e2e::e2e::install_fixture::file_sha256(path)?,
            ))
        })
        .collect()
}

// Fresh writable inputs make the regression independent of previous scenarios.
// Separate processes also exercise concurrent publication and snapshot reuse.
fn source_check_processes() -> Result<(), HarnessError> {
    let mut inputs = Sandbox::mutates_installation("INSTALL-PRIVATE-SOURCES")?;
    let temporary = inputs.root.join("children");
    fs::create_dir(&temporary)?;
    let mut children = Vec::new();
    for _ in 0..2 {
        children.push(
            std::process::Command::new(std::env::current_exe()?)
                .args([
                    "--exact",
                    "sandbox_installation::setup_and_teardown_preserve_source_modes_and_contents",
                    "--nocapture",
                ])
                .env("TMPDIR", &temporary)
                .env("BUTLER_E2E_SOURCE_CHECK_CHILD", "1")
                .env("BUTLER_E2E_BIN", &inputs.binary)
                .env("BUTLER_E2E_RESOURCES", &inputs.resources)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()?,
        );
    }
    // Reap every child before asserting, including a failed child.
    let outputs = children
        .into_iter()
        .map(std::process::Child::wait_with_output)
        .collect::<io::Result<Vec<_>>>()?;
    let mut identities = Vec::new();
    for output in outputs {
        assert!(output.status.success(), "{output:?}");
        let stdout = String::from_utf8(output.stdout).map_err(io::Error::other)?;
        identities.push(
            stdout
                .lines()
                .find(|line| line.starts_with("snapshot inode:"))
                .ok_or_else(|| io::Error::other("missing snapshot identity"))?
                .to_owned(),
        );
    }
    assert_eq!(
        identities[0], identities[1],
        "processes did not share the snapshot"
    );
    inputs.mark_success();
    Ok(())
}
