//! Helper owns the mapping and streams the contained child's output.
use super::{Error, drive::Drive, prepare::PolicyFile, probe, sdk};
use crate::command_sandbox::mxc_policy::environment;
use std::{fs, path::Path};

pub(crate) fn main() -> Result<i32, Error> {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("--probe") => {
            println!("{}", probe::helper_probe()?);
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
    if std::env::var("BUTLER_WINDOWS_PROJECT_SANDBOX").as_deref() != Ok("1") {
        return Err("mxc_disabled".into());
    }
    let cwd = dunce::canonicalize(std::env::current_dir()?)?;
    let relative = cwd
        .strip_prefix(&payload.project)
        .map_err(|_| "cwd_outside_project")?;
    let drive = Drive::claim(&payload.data, &payload.project, file)?;
    let result = (|| {
        probe::rewrite_drive(
            &mut payload.request,
            drive.letter,
            relative.to_str().ok_or("invalid cwd")?,
        )?;
        files(&payload, drive.letter)?;
        sdk::run(&payload.request)
    })();
    // Cleanup failures must not masquerade as successful containment.
    drive.cleanup()?;
    fs::remove_file(file)?;
    fs::remove_dir_all(&payload.scratch)?;
    result
}
fn files(payload: &PolicyFile, drive: char) -> Result<(), Error> {
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
    let env = payload.request["process"]["env"]
        .as_array()
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
