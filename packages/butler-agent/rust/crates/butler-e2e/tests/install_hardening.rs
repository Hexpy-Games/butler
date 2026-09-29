//! INS-09..13 — what the installer does when things go wrong, and what it
//! leaves alone: a failed restart puts back what was running, a login job is
//! never set up without an installed Agent, a purge deletes only a Butler data
//! folder, a download is verified, capped and cleaned up, and directories an
//! earlier installer made are never pruned.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

mod install_support;

use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::agent::Launch;
use butler_e2e::e2e::install_fixture::{
    Archive, RawEntry, build_failing_archive, build_stub_archive, file_sha256, hostile_archive,
    release_platform, write_update_manifest,
};
use butler_e2e::e2e::sandbox::Sandbox;
use butler_e2e::e2e::stop_intent::{StopOnDrop, instance_record};
use install_support::{error_code, ok, run, sandbox};
use serde_json::Value;

/// Marks the sandbox installation as an installed payload of version 0.0.1,
/// so `butler update` knows the version it runs.
fn mark_installed(sandbox: &Sandbox) -> Result<(), HarnessError> {
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
    Ok(())
}

fn ready_record(sandbox: &Sandbox) -> Value {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Some(record) =
            instance_record(&sandbox.data).filter(|record| record["state"] == "ready")
        {
            return record;
        }
        assert!(Instant::now() < deadline, "no ready service record");
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn entries(directory: &Path) -> usize {
    fs::read_dir(directory).map_or(0, Iterator::count)
}

/// INS-09 — an update whose restart fails leaves the service running from
/// the installation it ran from, and no version active that was not before:
/// there was no `current` to go back to, so `current` is removed again and
/// no launcher runs the version that failed.
#[test]
fn ins_09_failed_restart_restores_what_was_running() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (sandbox, mut launch) = sandbox("INS-09")?;
    launch.use_data_folder_token();
    mark_installed(&sandbox)?;
    let _stop = StopOnDrop(launch.clone());
    ok(&run(launch.command().args(["start", "--json"]))?)?;
    let before = ready_record(&sandbox);

    let bad = build_failing_archive(&sandbox.root.join("fixtures"), "0.0.2", "bad")?;
    let manifest = sandbox.root.join("update.json");
    write_update_manifest(&manifest, &[(Some(release_platform()), &bad)])?;
    launch.set_env("BUTLER_UPDATE_MANIFEST", manifest.display().to_string());
    let output = run(launch
        .command()
        .args(["update", "--apply", "--yes", "--json"]))?;
    assert_eq!(error_code(&output)?, "update_restart_failed");
    assert!(output.stdout.contains("running again"), "{}", output.stdout);

    let after = ready_record(&sandbox);
    assert_eq!(after["executable"], before["executable"], "{after}");
    assert_ne!(
        after["nonce"], before["nonce"],
        "the service was not restored"
    );
    let home = sandbox.root.join("agent-home");
    assert!(
        fs::symlink_metadata(home.join("current")).is_err(),
        "the failed version is still active"
    );
    assert!(
        !sandbox.home.join(".local/bin/butler").exists(),
        "a launcher runs the version that failed"
    );

    // An update whose archive cannot be installed leaves no download under DATA.
    let broken = sandbox.root.join("fixtures/broken.tar.gz");
    hostile_archive(
        &broken,
        &[RawEntry {
            name: "butler-agent",
            kind: tar::EntryType::Regular,
            link: None,
            data: b"x",
        }],
    )?;
    let offered = Archive {
        sha256: file_sha256(&broken)?,
        path: broken,
        version: "0.0.3".into(),
        dir: String::new(),
    };
    write_update_manifest(&manifest, &[(Some(release_platform()), &offered)])?;
    let output = run(launch
        .command()
        .args(["update", "--apply", "--yes", "--json"]))?;
    assert_eq!(error_code(&output)?, "install_manifest_invalid");
    assert_eq!(
        entries(&sandbox.data.join("updates/artifacts")),
        0,
        "the download of a failed update was kept"
    );
    Ok(())
}

/// INS-10 — a login job needs an installed Agent and runs it through
/// `current`; its environment is fixed, not the installing shell's; and only
/// a registration that runs a program inside the Agent home is removed with
/// it, judged by path and not by text.
#[test]
fn ins_10_login_job_needs_an_installed_agent() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (sandbox, mut launch) = sandbox("INS-10")?;
    launch.set_env("PATH", "/opt/leak/bin:/usr/bin:/bin");
    let fixtures = sandbox.root.join("fixtures");
    let service = |launch: &Launch, args: &[&str]| run(launch.command().args(args));

    // Nothing is installed: refused, and nothing is written.
    let refused = service(&launch, &["service", "install", "--files-only", "--json"])?;
    assert_eq!(refused.code, Some(1), "{}", refused.stdout);
    assert!(
        refused.stderr.contains("install the Agent first"),
        "{}",
        refused.stderr
    );
    let status = ok(&service(&launch, &["service", "status", "--json"])?)?;
    assert_eq!(status["data"]["registered"], false, "{status}");

    let archive = build_stub_archive(&fixtures, "1.0.0", "job")?;
    ok(&run(launch.command().args([
        "install",
        "--from",
        &archive.path.display().to_string(),
        "--no-restart",
        "--json",
    ]))?)?;
    let installed = ok(&service(
        &launch,
        &["service", "install", "--files-only", "--json"],
    )?)?;
    let definition = std::path::PathBuf::from(installed["data"]["definition"].as_str().unwrap());
    let text = fs::read_to_string(&definition)?;
    let home = sandbox.root.join("agent-home");
    assert!(
        text.contains(&format!("{}/current/butler-agent", home.display())),
        "{text}"
    );
    assert!(
        !text.contains("/opt/leak/bin"),
        "the shell's PATH leaked: {text}"
    );

    // A home whose name is a prefix of ours does not own the registration.
    let mut sibling = launch.clone();
    sibling.set_env(
        "BUTLER_AGENT_HOME",
        sandbox.root.join("agent").display().to_string(),
    );
    let kept = ok(&service(
        &sibling,
        &[
            "uninstall",
            "--keep-data",
            "--yes",
            "--files-only",
            "--json",
        ],
    )?)?;
    assert_eq!(
        kept["data"]["loginStart"]["state"], "absent-or-not-ours",
        "{kept}"
    );
    assert!(
        definition.exists(),
        "another home's uninstall removed the registration"
    );
    assert!(
        sandbox.home.join(".local/bin/butler").exists(),
        "another home's uninstall removed the launcher"
    );
    let removed = ok(&service(
        &launch,
        &[
            "uninstall",
            "--keep-data",
            "--yes",
            "--files-only",
            "--json",
        ],
    )?)?;
    assert_eq!(
        removed["data"]["loginStart"]["state"], "removed",
        "{removed}"
    );
    assert!(!definition.exists());
    Ok(())
}

/// INS-11 — `--purge-data` deletes a Butler data folder and nothing else: not
/// a folder that does not look like one, and not a link (checked as named,
/// before its links are resolved).
#[test]
fn ins_11_purge_deletes_only_a_butler_data_folder() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (sandbox, launch) = sandbox("INS-11")?;
    let purge = |data: &Path| {
        run(launch.command().args([
            "uninstall",
            "--purge-data",
            "--yes",
            "--files-only",
            "--data",
            &data.display().to_string(),
            "--json",
        ]))
    };
    let stranger = sandbox.root.join("documents");
    fs::create_dir_all(&stranger)?;
    fs::write(stranger.join("thesis.txt"), "keep")?;
    assert_eq!(error_code(&purge(&stranger)?)?, "unsafe_path");
    assert!(stranger.join("thesis.txt").exists());

    let real = sandbox.root.join("real-data");
    fs::create_dir_all(real.join("state"))?;
    fs::write(real.join("state/marker"), "data")?;
    let link = sandbox.root.join("link-data");
    butler_platform::secure_fs::symlink(&real, &link)?;
    assert_eq!(error_code(&purge(&link)?)?, "unsafe_path");
    assert!(real.join("state/marker").exists(), "a link was followed");

    let purged = ok(&purge(&real)?)?;
    assert_eq!(purged["data"]["data"]["purged"], true, "{purged}");
    assert!(!real.exists());
    Ok(())
}

/// Serves `body` at `/a.tar.gz` on a loopback port, and beside it `/stream`
/// (4 MiB with no Content-Length), `/redirect` (to `/a.tar.gz` on the same
/// origin) and `/out` (a redirect to plain http on another host).
async fn serve(body: Vec<u8>) -> Result<u16, HarnessError> {
    use axum::response::Redirect;
    use axum::routing::get;
    let bytes = bytes::Bytes::from(body);
    let app = axum::Router::new()
        .route(
            "/a.tar.gz",
            get(move || {
                let bytes = bytes.clone();
                async move { bytes }
            }),
        )
        .route(
            "/stream",
            get(|| async {
                let chunk = bytes::Bytes::from(vec![7_u8; 65536]);
                let chunks = (0..64).map(move |_| Ok::<_, std::io::Error>(chunk.clone()));
                axum::body::Body::from_stream(futures_util::stream::iter(chunks))
            }),
        )
        .route(
            "/redirect",
            get(|| async { Redirect::temporary("/a.tar.gz") }),
        )
        .route(
            "/out",
            get(|| async { Redirect::temporary("http://example.invalid/a.tar.gz") }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok(port)
}

/// INS-12 — `install --from URL` needs its digest, refuses plain http to
/// anywhere but this machine, caps the download, and leaves no download
/// behind (nor anything under DATA), whether the install worked or not.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ins_12_a_download_is_verified_capped_and_cleaned_up() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (sandbox, launch) = sandbox("INS-12")?;
    let archive = build_stub_archive(&sandbox.root.join("fixtures"), "1.0.0", "url")?;
    let port = serve(fs::read(&archive.path)?).await?;
    let url = format!("http://127.0.0.1:{port}/a.tar.gz");
    let install = |url: &str, sha: Option<&str>, extra: Option<(&str, &str)>| {
        let mut command = launch.command();
        command.args(["install", "--from", url, "--no-restart", "--json"]);
        if let Some(sha) = sha {
            command.args(["--sha256", sha]);
        }
        if let Some((key, value)) = extra {
            command.env(key, value);
        }
        run(&mut command)
    };
    let scratch_left = || {
        fs::read_dir(sandbox.root.join("tmp")).map_or(0, |entries| {
            entries
                .flatten()
                .filter(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("butler-install-")
                })
                .count()
        })
    };

    assert_eq!(
        error_code(&install(&url, None, None)?)?,
        "invalid_arguments"
    );
    let insecure = install(
        "http://example.invalid/a.tar.gz",
        Some(&archive.sha256),
        None,
    )?;
    assert_eq!(error_code(&insecure)?, "update_artifact_source_invalid");
    let wrong = install(&url, Some(&"0".repeat(64)), None)?;
    assert_eq!(error_code(&wrong)?, "update_artifact_sha256_mismatch");
    let capped = install(
        &url,
        Some(&archive.sha256),
        Some(("BUTLER_INSTALL_MAX_BYTES", "100")),
    )?;
    assert_eq!(error_code(&capped)?, "install_archive_too_large");
    // The cap holds for a body that announces no length, too.
    let streamed = install(
        &format!("http://127.0.0.1:{port}/stream"),
        Some(&archive.sha256),
        Some(("BUTLER_INSTALL_MAX_BYTES", "100000")),
    )?;
    assert_eq!(error_code(&streamed)?, "install_archive_too_large");
    // A redirect within this machine is followed (the download reaches its
    // digest check); one to plain http elsewhere is not.
    let followed = install(
        &format!("http://127.0.0.1:{port}/redirect"),
        Some(&"0".repeat(64)),
        None,
    )?;
    assert_eq!(error_code(&followed)?, "update_artifact_sha256_mismatch");
    let refused = install(
        &format!("http://127.0.0.1:{port}/out"),
        Some(&archive.sha256),
        None,
    )?;
    assert_eq!(error_code(&refused)?, "update_artifact_unavailable");
    assert_eq!(scratch_left(), 0, "a failed download was left behind");
    assert!(!sandbox.root.join("agent-home").join(&archive.dir).exists());

    let installed = ok(&install(&url, Some(&archive.sha256), None)?)?;
    assert_eq!(
        installed["data"]["dir"],
        archive.dir.as_str(),
        "{installed}"
    );
    assert_eq!(scratch_left(), 0, "the download was left behind");
    assert_eq!(
        entries(&sandbox.data.join("updates")),
        0,
        "the download went through DATA"
    );
    Ok(())
}

/// INS-13 — a directory an earlier installer named `<version>-rust-<sha8>` is
/// a version like the others: it is listed and can be rolled back to, and it
/// is never pruned or removed.
#[test]
fn ins_13_legacy_directories_are_rollback_targets_and_never_pruned() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (sandbox, launch) = sandbox("INS-13")?;
    let home = sandbox.root.join("agent-home");
    let fixtures = sandbox.root.join("fixtures");
    let cli = |args: &[&str]| {
        let mut command = launch.command();
        command.args(args).arg("--json");
        run(&mut command)
    };
    let install = |archive: &butler_e2e::e2e::install_fixture::Archive| {
        cli(&[
            "install",
            "--from",
            &archive.path.display().to_string(),
            "--no-restart",
        ])
    };

    let old = build_stub_archive(&fixtures, "0.0.21", "legacy")?;
    ok(&install(&old)?)?;
    let sha8 = old.dir.rsplit('-').next().unwrap().to_owned();
    let legacy = format!("0.0.21-rust-{sha8}");
    fs::rename(home.join(&old.dir), home.join(&legacy))?;
    fs::remove_file(home.join("current"))?;

    for n in 1..=5 {
        ok(&install(&build_stub_archive(
            &fixtures,
            &format!("1.0.{n}"),
            "new",
        )?)?)?;
    }
    assert!(home.join(&legacy).is_dir(), "a legacy directory was pruned");
    let listed = ok(&cli(&["versions"])?)?;
    let versions = listed["data"]["versions"].as_array().unwrap();
    let entry = versions
        .iter()
        .find(|entry| entry["dir"] == legacy.as_str())
        .unwrap_or_else(|| panic!("the legacy directory is not listed: {listed}"));
    assert_eq!(entry["legacy"], true, "{entry}");

    ok(&cli(&[
        "rollback",
        "--to",
        &legacy,
        "--yes",
        "--no-restart",
    ])?)?;
    assert_eq!(
        fs::read_link(home.join("current"))?.display().to_string(),
        legacy
    );
    ok(&cli(&[
        "rollback",
        "--to",
        "1.0.5",
        "--yes",
        "--no-restart",
    ])?)?;

    let removed = ok(&cli(&["uninstall", "--yes", "--files-only"])?)?;
    assert!(
        home.join(&legacy).is_dir(),
        "uninstall removed a legacy directory: {removed}"
    );
    assert_eq!(removed["data"]["agentHome"]["removed"], false, "{removed}");
    Ok(())
}
