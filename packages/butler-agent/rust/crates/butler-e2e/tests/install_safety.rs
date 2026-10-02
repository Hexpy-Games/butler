//! INS-03..06 — what the installer refuses and what it reads: the version of
//! an App layout, hostile archives, a busy Agent home, and which artifact of
//! an update manifest is this host's.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

mod install_support;

use std::fs;
use std::path::Path;

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::agent::Launch;
use butler_e2e::e2e::install_fixture::{
    Archive, RawEntry, file_sha256, hostile_archive, release_platform, tree_sha256,
    write_update_manifest,
};
use butler_platform::instance::InstanceLock;
use install_support::{error_code, run, sandbox};
use tar::EntryType;

/// INS-03 — `butler version` reads the manifest of an App-bundled Agent in
/// both App layouts (a package directory whose payload sits under
/// `resources/bundled-agent`, and a macOS app bundle whose payload sits under
/// `Contents/Resources/bundled-agent`), where the installation root is the
/// App and not the payload.
#[test]
fn ins_03_version_reads_the_bundled_payload_manifest() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut sandbox, launch) = sandbox("INS-03")?;
    for (name, installation, payload) in [
        (
            "package",
            "Butler-linux-x64",
            "Butler-linux-x64/resources/bundled-agent",
        ),
        (
            "bundle",
            "Butler.app",
            "Butler.app/Contents/Resources/bundled-agent",
        ),
    ] {
        let root = sandbox.root.join("apps").join(name);
        let payload = root.join(payload);
        fs::create_dir_all(payload.join("bin"))?;
        butler_e2e::e2e::executable::copy(&sandbox.binary, &payload.join("bin/butler-agent"))?;
        butler_e2e::e2e::sandbox::copy_tree(&sandbox.resources, &payload.join("resources"))?;
        fs::write(
            payload.join("native-agent-manifest.json"),
            serde_json::json!({
                "schema": "butler.native-agent-payload.v1",
                "version": "7.7.7",
                "appVersion": "1.2.3",
                "binary": "bin/butler-agent",
                "resources": "resources",
                "binarySha256": file_sha256(&payload.join("bin/butler-agent"))?,
                "resourcesSha256": tree_sha256(&payload.join("resources"))?,
            })
            .to_string(),
        )?;
        let installation = root.join(installation);
        let command = |args: &[&str]| {
            let mut command = launch.env_command(&payload.join("bin/butler-agent"));
            command
                .arg("--installation-root")
                .arg(&installation)
                .arg("--resource-root")
                .arg(payload.join("resources"))
                .args(args);
            run(&mut command)
        };
        let version = command(&["version", "--json"])?;
        let value = version.json()?;
        assert_eq!(value["data"]["version"], "7.7.7", "{name}: {value}");
        assert_eq!(value["data"]["appVersion"], "1.2.3", "{name}: {value}");
        assert_eq!(
            value["data"]["availability"], "installed_manifest",
            "{name}"
        );
        assert_eq!(command(&["version"])?.stdout.trim(), "Butler native 7.7.7");
        let doctor = command(&["doctor", "--check", "installation", "--json"])?.json()?;
        for check in doctor["data"]["checks"].as_array().unwrap() {
            assert_eq!(check["status"], "pass", "{name}: {check}");
        }
    }
    sandbox.mark_success();
    Ok(())
}

/// INS-04 — an archive that could write outside the Agent home, or does not
/// match its own digests, is refused whole: nothing is installed, and
/// nothing lands anywhere else.
#[test]
fn ins_04_hostile_archives_install_nothing() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut sandbox, launch) = sandbox("INS-04")?;
    let home = sandbox.root.join("agent-home");
    let archives = sandbox.root.join("archives");
    fs::create_dir_all(&archives)?;
    // Short enough for a tar header; the file only exists if the installer
    // is vulnerable, and is removed then.
    let absolute = std::env::temp_dir().join(format!(
        "bi04-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    ));
    let absolute_name = absolute.display().to_string();
    let file = |name| RawEntry {
        name,
        kind: EntryType::Regular,
        link: None,
        data: b"pwned",
    };
    let link = |name, target| RawEntry {
        name,
        kind: EntryType::Symlink,
        link: Some(target),
        data: b"",
    };
    let dir = |name| RawEntry {
        name,
        kind: EntryType::Directory,
        link: None,
        data: b"",
    };
    let cases: Vec<(&str, Vec<RawEntry<'_>>, &str)> = vec![
        (
            "dotdot",
            vec![file("../escape.txt")],
            "install_archive_unsafe",
        ),
        (
            "nested-dotdot",
            vec![dir("a"), file("a/../../escape.txt")],
            "install_archive_unsafe",
        ),
        (
            "absolute",
            vec![file(&absolute_name)],
            "install_archive_unsafe",
        ),
        (
            "link-out",
            vec![link("l", "../../outside")],
            "install_archive_unsafe",
        ),
        (
            "link-absolute",
            vec![link("l", "/etc")],
            "install_archive_unsafe",
        ),
        (
            "link-then-up",
            vec![dir("d"), link("d/l", "sub/../../..")],
            "install_archive_unsafe",
        ),
        (
            "write-through-link",
            vec![dir("sub"), link("d", "sub"), file("d/pwned.txt")],
            "install_archive_unsafe",
        ),
        (
            "hard-link",
            vec![RawEntry {
                name: "h",
                kind: EntryType::Link,
                link: Some("butler-agent"),
                data: b"",
            }],
            "install_archive_unsafe",
        ),
        (
            "duplicate",
            vec![file("x"), file("x")],
            "install_archive_unsafe",
        ),
        (
            "device",
            vec![RawEntry {
                name: "dev",
                kind: EntryType::Char,
                link: None,
                data: b"",
            }],
            "install_archive_unsafe",
        ),
        (
            "no-manifest",
            vec![file("butler-agent")],
            "install_manifest_invalid",
        ),
    ];
    for (name, entries, expected) in &cases {
        let path = archives.join(format!("{name}.tar.gz"));
        hostile_archive(&path, entries)?;
        let output = run(launch.command().args([
            "install",
            "--from",
            &path.display().to_string(),
            "--json",
        ]))?;
        assert_eq!(&error_code(&output)?, expected, "{name}: {}", output.stdout);
        assert_nothing_installed(&home, name);
        assert!(
            !sandbox.root.join("escape.txt").exists(),
            "{name}: escaped the home"
        );
        assert!(
            !home.join("escape.txt").exists(),
            "{name}: escaped the staging dir"
        );
        if absolute.exists() {
            let _ = fs::remove_file(&absolute);
            panic!("{name}: wrote an absolute path");
        }
        assert!(
            !sandbox.root.join("outside").exists(),
            "{name}: followed a link"
        );
    }

    // A digest that does not match is refused before anything is extracted.
    let path = archives.join("dotdot.tar.gz");
    let output = run(launch.command().args([
        "install",
        "--from",
        &path.display().to_string(),
        "--sha256",
        &"0".repeat(64),
        "--json",
    ]))?;
    assert_eq!(error_code(&output)?, "update_artifact_sha256_mismatch");
    assert_nothing_installed(&home, "sha256");
    // A download needs its digest.
    let output = run(launch.command().args([
        "install",
        "--from",
        "https://example.invalid/agent.tar.gz",
        "--json",
    ]))?;
    assert_eq!(error_code(&output)?, "invalid_arguments");
    // Not an archive at all.
    let text = archives.join("plain.txt");
    fs::write(&text, "not an archive")?;
    let output =
        run(launch
            .command()
            .args(["install", "--from", &text.display().to_string(), "--json"]))?;
    assert_eq!(error_code(&output)?, "install_archive_format_unsupported");
    assert_nothing_installed(&home, "plain");
    sandbox.mark_success();
    Ok(())
}

/// The Agent home holds no version and no pointer, and no staging leftovers.
fn assert_nothing_installed(home: &Path, case: &str) {
    let names: Vec<String> = fs::read_dir(home)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| name != ".install.lock")
                .collect()
        })
        .unwrap_or_default();
    assert!(names.is_empty(), "{case}: the Agent home holds {names:?}");
}

/// INS-05 — two changes to the Agent home cannot interleave: while another
/// process holds its lock, `install` reports the home busy and changes
/// nothing; once the lock is released the same command gets past it.
#[test]
fn ins_05_a_busy_agent_home_is_not_modified() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut sandbox, launch) = sandbox("INS-05")?;
    let home = sandbox.root.join("agent-home");
    fs::create_dir_all(&home)?;
    let archive = sandbox.root.join("empty.tar.gz");
    hostile_archive(&archive, &[])?;
    let install = || {
        run(launch.command().args([
            "install",
            "--from",
            &archive.display().to_string(),
            "--json",
        ]))
    };
    let lock = InstanceLock::try_exclusive(
        fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(home.join(".install.lock"))?,
    )
    .map_err(|_| butler_e2e::e2e::harness_error("cannot take the lock"))?;
    assert_eq!(error_code(&install()?)?, "install_busy");
    assert_nothing_installed(&home, "busy");
    drop(lock);
    // The lock is free: the empty archive now fails on its content instead.
    assert_eq!(error_code(&install()?)?, "install_manifest_invalid");
    sandbox.mark_success();
    Ok(())
}

/// INS-06 — `butler update` offers only the artifact built for this host:
/// one for another platform, or one that names none, is never chosen.
#[test]
fn ins_06_update_selects_only_this_platform() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut sandbox, mut launch) = sandbox("INS-06")?;
    fs::write(
        sandbox.install.join("native-agent-manifest.json"),
        serde_json::json!({
            "schema": "butler.native-agent-payload.v1",
            "version": "0.0.1",
            "binary": "bin/butler-agent",
            "resources": "resources",
        })
        .to_string(),
    )?;
    let offered = |version: &str| Archive {
        path: sandbox.root.join(format!("offered-{version}.tar.gz")),
        sha256: "0".repeat(64),
        version: version.to_owned(),
        dir: String::new(),
    };
    let (unlabelled, other, mine) = (offered("9.0.0"), offered("8.0.0"), offered("0.0.2"));
    let manifest = sandbox.root.join("update.json");
    launch.set_env("BUTLER_UPDATE_MANIFEST", manifest.display().to_string());
    let check = |launch: &Launch| run(launch.command().args(["update", "--check", "--json"]));

    write_update_manifest(&manifest, &[(None, &unlabelled)])?;
    assert_eq!(
        error_code(&check(&launch)?)?,
        "update_manifest_agent_platform_missing"
    );
    write_update_manifest(&manifest, &[(Some("plan9-mips".into()), &other)])?;
    assert_eq!(
        error_code(&check(&launch)?)?,
        "update_manifest_agent_platform_missing"
    );

    write_update_manifest(
        &manifest,
        &[
            (None, &unlabelled),
            (Some("plan9-mips".into()), &other),
            (Some(release_platform()), &mine),
        ],
    )?;
    let value = check(&launch)?.json()?;
    assert_eq!(value["ok"], true, "{value}");
    assert_eq!(value["data"]["available_version"], "0.0.2", "{value}");
    assert_eq!(
        value["data"]["platform"],
        release_platform().as_str(),
        "{value}"
    );
    sandbox.mark_success();
    Ok(())
}
