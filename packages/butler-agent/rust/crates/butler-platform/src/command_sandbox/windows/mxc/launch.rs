//! Helper owns the mapping and streams the contained child's output.
use super::{Error, drive::Drive, prepare::PolicyFile, probe, sdk};
use crate::command_sandbox::mxc_policy::environment;
use std::{fs, io::Write, path::Path};

pub(crate) fn main() -> Result<i32, Error> {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("--probe") => {
            let diagnostic = match args.next().as_deref() {
                None => None,
                Some("--diagnostic") => Some(args.next().ok_or("missing diagnostic path")?),
                _ => return Err("invalid probe argument".into()),
            };
            println!(
                "{}",
                probe::helper_probe(diagnostic.as_deref().map(Path::new))?
            );
            Ok(0)
        }
        Some("--probe-child") => {
            let _ = winsafe::GetSystemMetrics(winsafe::co::SM::CXSCREEN);
            println!("{}", args.next().ok_or("missing nonce")?);
            Ok(0)
        }
        Some("--policy-file") => {
            let file = args.next().ok_or("missing policy file")?;
            if args.next().as_deref() != Some("--") {
                return Err("missing separator".into());
            }
            match run(Path::new(&file)) {
                Err(error) if error.is::<sdk::RunError>() => {
                    eprintln!(
                        "{error}\n{}",
                        crate::command_sandbox::EXECUTION_FAILURE_MARKER
                    );
                    Ok(crate::command_sandbox::EXECUTION_FAILURE_EXIT)
                }
                result => result,
            }
        }
        _ => Err("invalid helper mode".into()),
    }
}
fn run(file: &Path) -> Result<i32, Error> {
    let phase = super::timing::Phase::start("helper");
    let ownership = super::timing::Phase::start("policy_ownership");
    let mut payload: PolicyFile = serde_json::from_slice(&fs::read(file)?)?;
    let (pid, started) = super::drive::identity()?;
    payload.pid = pid;
    payload.started = started;
    // A sharing-exclusive write publishes the helper identity to recovery.
    // Torn writes are reconciled; reboot also destroys the ephemeral mappings.
    use std::os::windows::fs::OpenOptionsExt;
    let mut policy = fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .share_mode(0)
        .open(file)?;
    policy.write_all(&serde_json::to_vec(&payload)?)?;
    drop(policy);
    drop(ownership);
    let mut drives = Vec::new();
    let result = execute(file, &mut payload, &mut drives);
    cleanup(file, &payload.scratch, &drives);
    drop(phase);
    result.map(sdk::RunOutcome::report)
}
fn execute(
    file: &Path,
    payload: &mut PolicyFile,
    drives: &mut Vec<Drive>,
) -> Result<sdk::RunOutcome, Error> {
    if std::env::var("BUTLER_WINDOWS_PROJECT_SANDBOX").as_deref() == Ok("0") {
        return Err("mxc_disabled".into());
    }
    let cwd = crate::secure_fs::canonicalize(std::env::current_dir()?)?;
    let relative = cwd
        .strip_prefix(&payload.project)
        .map_err(|_| "cwd_outside_project")?;
    let relative = relative.to_str().ok_or("invalid cwd")?.to_owned();
    let drive = Drive::claim(&payload.data, &payload.project, file)?;
    let letter = drive.letter;
    drives.push(drive);
    let temp_phase = super::timing::Phase::start("temp_setup");
    let (temporary, path) = Drive::temporary(&payload.data, &payload.scratch, file)?;
    drives.extend(temporary);
    drop(temp_phase);
    run_mapped(payload, letter, &path, &relative)
}

fn cleanup(file: &Path, scratch: &Path, drives: &[Drive]) {
    let _phase = super::timing::Phase::start("cleanup");
    // The container and both output relays are finished. Removing a mapping and
    // removing physical scratch are independent; neither needs to delay the other.
    // Reap subst before returning so the next command sees no outstanding cleanup.
    let pending: Vec<_> = drives.iter().map(Drive::start_cleanup).collect();
    {
        let _phase = super::timing::Phase::start("scratch_cleanup");
        let result = fs::remove_dir_all(scratch).and_then(|()| fs::remove_file(file));
        let _ = finish_cleanup(Ok(()), result);
    }
    for cleanup in pending {
        let result = cleanup.and_then(super::drive::Cleanup::finish);
        let _ = finish_cleanup(Ok(()), result);
    }
}

fn run_mapped(
    payload: &mut PolicyFile,
    project_drive: char,
    temporary: &str,
    relative: &str,
) -> Result<sdk::RunOutcome, Error> {
    // Only the environment uses the short alias: all filesystem grants still
    // name the exact physical command scratch. Both mappings share crash recovery.
    let env = payload
        .request
        .pointer_mut("/process/env")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or("missing environment")?;
    for item in env {
        if let Some(key) = item.as_str().and_then(|s| s.split_once('=').map(|p| p.0))
            && matches!(key, "TEMP" | "TMP")
        {
            *item = format!("{key}={temporary}").into();
        }
    }
    super::shell::prepare(&mut payload.request, &payload.scratch, temporary)?;
    rewrite_git_config(payload, project_drive)?;
    probe::rewrite_drive(&mut payload.request, project_drive, relative)?;
    sdk::run(&payload.request)
}
pub(super) fn files(payload: &PolicyFile, drive: char) -> Result<(), Error> {
    let _phase = super::timing::Phase::start("scratch_files");
    let scratch = &payload.scratch;
    for name in [
        "home/AppData/Roaming",
        "home/AppData/Local",
        "t",
        "bin",
        "npm-cache",
    ] {
        fs::create_dir_all(scratch.join(name))?;
    }
    fs::write(
        scratch.join("gitconfig"),
        environment::git_config(&payload.git_settings, drive)?,
    )?;
    fs::write(scratch.join("npmrc"), "")?;
    let env = payload
        .request
        .pointer("/process/env")
        .and_then(serde_json::Value::as_array)
        .ok_or("missing env")?;
    let path = env
        .iter()
        .filter_map(|v| v.as_str())
        .find_map(|s| s.strip_prefix("PATH="))
        .ok_or("missing PATH")?;
    let node = path
        .split(';')
        .map(Path::new)
        .find(|p| p.join("node.exe").is_file());
    if let Some(node) = node {
        npm(scratch, node, "npm", "--preserve-symlinks-main")?;
        npm(scratch, node, "npx", "--preserve-symlinks-main")?;
    }
    Ok(())
}
fn npm(scratch: &Path, node: &Path, name: &str, main: &str) -> Result<(), Error> {
    let cli = node.join(format!("node_modules/npm/bin/{name}-cli.js"));
    if !cli.is_file() {
        return Ok(());
    }
    for path in [node, &cli] {
        if path.to_string_lossy().contains(['%', '"', '\r', '\n']) {
            return Err("unsafe_npm_wrapper_path".into());
        }
    }
    fs::write(
        scratch.join(format!("bin/{name}.cmd")),
        format!(
            "@echo off\r\n\"{}\" --preserve-symlinks {main} \"{}\" %*\r\n",
            node.join("node.exe").display(),
            cli.display()
        ),
    )?;
    Ok(())
}

fn rewrite_git_config(payload: &PolicyFile, drive: char) -> Result<(), Error> {
    // Scratch was prepared before launch. Do not follow a replaced directory or file.
    for path in [&payload.scratch, &payload.scratch.join("gitconfig")] {
        use std::os::windows::fs::MetadataExt;
        if fs::symlink_metadata(path)?.file_attributes() & 0x400 != 0 {
            return Err("scratch_reparse_point".into());
        }
    }
    fs::write(
        payload.scratch.join("gitconfig"),
        environment::git_config(&payload.git_settings, drive)?,
    )?;
    Ok(())
}

fn finish_cleanup<T>(result: Result<T, Error>, cleanup: std::io::Result<()>) -> Result<T, Error> {
    if let Err(error) = cleanup {
        eprintln!("sandbox cleanup failed: {error}");
    }
    result
}

#[cfg(feature = "test-support")]
pub(in crate::command_sandbox) fn verify_cleanup_status() {
    let cleaned = verify_parallel_cleanup();
    assert!(cleaned.is_ok(), "{cleaned:?}");
    for code in [0, 17, 124, 125] {
        assert!(
            finish_cleanup(Ok(code), Err(std::io::Error::other("cleanup failure")))
                .is_ok_and(|result| result == code)
        );
    }
    let result = finish_cleanup::<i32>(Err("no_free_drive".into()), Ok(()));
    assert!(result.is_err_and(|error| error.to_string() == "no_free_drive"));
}

#[cfg(feature = "test-support")]
fn verify_parallel_cleanup() -> Result<(), Error> {
    let root = std::env::temp_dir().join(format!("cleanup-{}", std::process::id()));
    let project = root.join("project");
    let scratch = root.join("scratch");
    let file = root.join("policy.json");
    fs::create_dir_all(&project)?;
    fs::create_dir_all(scratch.join("t"))?;
    fs::write(&file, "policy")?;
    fs::write(scratch.join("t/output"), "complete")?;
    let drive = Drive::claim(&root, &project, &file)?;
    let letter = drive.letter;
    cleanup(&file, &scratch, &[drive]);
    assert!(!scratch.exists());
    assert!(!file.exists());
    assert!(project.exists());
    assert_eq!(fs::read_dir(root.join("sandbox/drives"))?.count(), 0);
    assert_eq!(
        winsafe::GetLogicalDrives() & (1 << (letter as u8 - b'A')),
        0
    );
    fs::remove_dir_all(root)?;
    Ok(())
}
