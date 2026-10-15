//! Helper owns the mapping and streams the contained child's output.
use super::{Error, drive::Drive, prepare::PolicyFile, probe, sdk};
use crate::command_sandbox::mxc_policy::environment;
use std::{fs, path::Path};

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
            run(Path::new(&file))
        }
        _ => Err("invalid helper mode".into()),
    }
}
fn run(file: &Path) -> Result<i32, Error> {
    let mut payload: PolicyFile = serde_json::from_slice(&fs::read(file)?)?;
    let (pid, started) = super::drive::identity()?;
    payload.pid = pid;
    payload.started = started;
    crate::secure_fs::replace_private(
        file,
        |file| serde_json::to_writer(file, &payload).map_err(std::io::Error::other),
        |error| error,
    )?;
    let result = execute(file, &mut payload);
    let cleanup = fs::remove_dir_all(&payload.scratch).and_then(|()| fs::remove_file(file));
    finish_cleanup(result, cleanup).map(sdk::RunOutcome::report)
}
fn execute(file: &Path, payload: &mut PolicyFile) -> Result<sdk::RunOutcome, Error> {
    if std::env::var("BUTLER_WINDOWS_PROJECT_SANDBOX").as_deref() != Ok("1") {
        return Err("mxc_disabled".into());
    }
    let cwd = dunce::canonicalize(std::env::current_dir()?)?;
    let relative = cwd
        .strip_prefix(&payload.project)
        .map_err(|_| "cwd_outside_project")?;
    let relative = relative.to_str().ok_or("invalid cwd")?.to_owned();
    let drive = Drive::claim(&payload.data, &payload.project, file)?;
    let result = (|| {
        rewrite_git_config(payload, drive.letter)?;
        probe::rewrite_drive(&mut payload.request, drive.letter, &relative)?;
        sdk::run(&payload.request)
    })();
    finish_cleanup(result, drive.cleanup())
}
pub(super) fn files(payload: &PolicyFile, drive: char) -> Result<(), Error> {
    let scratch = &payload.scratch;
    for name in [
        "home/AppData/Roaming",
        "home/AppData/Local",
        "temp",
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
    for code in [0, 17, 124, 125] {
        assert!(
            finish_cleanup(Ok(code), Err(std::io::Error::other("cleanup failure")))
                .is_ok_and(|result| result == code)
        );
    }
    let result = finish_cleanup::<i32>(Err("no_free_drive".into()), Ok(()));
    assert!(result.is_err_and(|error| error.to_string() == "no_free_drive"));
}
