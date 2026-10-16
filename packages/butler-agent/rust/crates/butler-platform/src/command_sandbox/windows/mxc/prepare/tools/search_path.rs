//! Inspect executable paths; never execute host PATH binaries during admission.
use super::*;

pub(super) fn add_path(env: &BTreeMap<String, String>, input: &mut Discovery) -> Result<(), Error> {
    for dir in environment::get(env, "PATH").unwrap_or("").split(';') {
        let Ok(lexical) = WinPath::search_directory(dir) else {
            continue;
        };
        let Ok(canonical) = physical(Path::new(lexical.as_str())) else {
            continue;
        };
        if !toolchain::trusted_path(&canonical, input) {
            continue;
        }
        let path = Path::new(canonical.as_str());
        if path.join("node.exe").is_file() && input.real_node.is_none() {
            discover_node(path, input)?;
        }
        if path.join("git.exe").is_file()
            && canonical.as_str().ends_with("\\cmd")
            && toolchain::known_install(&canonical, input)
            && input.git_exe.is_none()
        {
            input.git_exe = Some(physical(&path.join("git.exe"))?);
        }
        input.path.push(canonical);
    }
    Ok(())
}

fn discover_node(path: &Path, input: &mut Discovery) -> Result<(), Error> {
    let executable = physical(&path.join("node.exe"))?;
    let mut node = executable.parent().ok_or("node parent")?;
    // Recent NVM for Windows uses a proxy rather than an executable symlink.
    // Resolve its configured version from metadata without running the proxy.
    if node.as_str().ends_with(r"\.shim") {
        input.shim_dirs.push(node.clone());
        let Some(selected) = nvm_active(&node)? else {
            return Ok(());
        };
        node = selected;
    }
    if toolchain::known_install(&node, input) {
        input.real_node = Some(node);
    }
    Ok(())
}

fn nvm_active(shim: &WinPath) -> Result<Option<WinPath>, Error> {
    use winsafe::{HKEY, RegistryValue, co};
    let key = match HKEY::CURRENT_USER.RegOpenKeyEx(
        Some(r"Software\Author Software\Preferences\nvm"),
        co::REG_OPTION::NON_VOLATILE,
        co::KEY::READ,
    ) {
        Ok(key) => key,
        Err(error) if error == co::ERROR::FILE_NOT_FOUND => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let version = match key.RegQueryValueEx(Some("ActiveVersion")) {
        Ok(RegistryValue::Sz(version)) => version,
        Ok(_) => return Ok(None),
        Err(error) if error == co::ERROR::FILE_NOT_FOUND => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let version = version.trim_start_matches('v');
    if version.is_empty() || !version.bytes().all(|c| c.is_ascii_digit() || c == b'.') {
        return Ok(None);
    }
    let root = shim.parent().ok_or("nvm parent")?;
    let install = root.join(&format!(r"installs\v{version}"))?;
    let Some(executable) = existing(&install.join("node.exe")?) else {
        return Ok(None);
    };
    Ok(executable.parent())
}
