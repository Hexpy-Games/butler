//! Resolve executable search directories before replacing the child profile.
use super::*;

pub(super) fn add_path(env: &BTreeMap<String, String>, input: &mut Discovery) -> Result<(), Error> {
    for dir in environment::get(env, "PATH")
        .unwrap_or("")
        .split(';')
        .filter(|s| !s.is_empty())
    {
        let path = Path::new(dir);
        if !path.is_dir() {
            continue;
        }
        let lexical = WinPath::search_directory(dir)
            .map_err(|reason| WinPath::rejection(dir, "PATH entry", reason))?;
        if lexical.as_str().ends_with("\\windowsapps") {
            continue;
        }
        let canonical = physical_for(path, "PATH entry")?;
        discover_rust(path, &canonical, input)?;
        if lexical.as_str().ends_with("\\.nodejs") {
            input.shim_dirs.push(canonical.clone());
        }
        if path.join("node.exe").is_file() && input.real_node.is_none() {
            discover_node(path, env, input)?;
        }
        if path.join("git.exe").is_file()
            && canonical.as_str().ends_with("\\cmd")
            && input.git_exe.is_none()
        {
            input.git_exe = Some(physical(&path.join("git.exe"))?);
        }
        input.path.push(canonical);
    }
    Ok(())
}

fn discover_rust(path: &Path, canonical: &WinPath, input: &mut Discovery) -> Result<(), Error> {
    if !path.join("cargo.exe").is_file() || !path.join("rustup.exe").is_file() {
        return Ok(());
    }
    if input.cargo_home.is_none() && canonical.as_str().ends_with("\\bin") {
        input.cargo_home = canonical.parent();
    }
    if input.rustup_home.is_none()
        && let Some(cargo) = &input.cargo_home
        && cargo.as_str().ends_with("\\.cargo")
        && let Some(profile) = cargo.parent()
    {
        input.rustup_home = existing(&profile.join(".rustup")?);
    }
    Ok(())
}

fn discover_node(
    path: &Path,
    env: &BTreeMap<String, String>,
    input: &mut Discovery,
) -> Result<(), Error> {
    let executable = path.join("node.exe");
    // A proxy may canonicalize to another proxy directory (for example NVM's
    // .shim). The selected runtime itself identifies its real installation.
    // Discovery is cached, so this executes only when the host environment changes.
    let output = Command::new(executable)
        .args(["-p", "process.execPath"])
        .env_clear()
        .envs(env)
        .output()?;
    if !output.status.success() {
        return Err("node_install_resolution_failed".into());
    }
    let resolved = String::from_utf8(output.stdout)?;
    let node = physical_for(Path::new(resolved.trim()), "Node executable")?
        .parent()
        .ok_or("node parent")?;
    input
        .install_roots
        .push(node.parent().ok_or("node install parent")?);
    input.real_node = Some(node);
    Ok(())
}
