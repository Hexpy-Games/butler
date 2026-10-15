//! Pure selection from host-collected toolchain evidence. Host I/O belongs to PR2.
use super::WinPath;
use std::collections::BTreeMap;

/// Host facts collected once per PATH change; canonical paths must be resolved by the host.
#[derive(Clone, Debug, Default)]
pub struct Discovery {
    /// Canonical PATH directories in host order.
    pub path: Vec<WinPath>,
    /// The host Windows installation.
    pub system_root: Option<WinPath>,
    /// Trusted Program Files roots.
    pub program_files: Vec<WinPath>,
    /// Other known install roots, such as NVM installs and Scoop apps.
    pub install_roots: Vec<WinPath>,
    /// Real Cargo home, mounted read-only.
    pub cargo_home: Option<WinPath>,
    /// Real rustup home, mounted read-only.
    pub rustup_home: Option<WinPath>,
    /// Resolved Git executable under its cmd directory.
    pub git_exe: Option<WinPath>,
    /// Original roaming app-data directory.
    pub app_data: Option<WinPath>,
    /// Original local app-data directory.
    pub local_app_data: Option<WinPath>,
    /// NVM and other alias directories to omit.
    pub shim_dirs: Vec<WinPath>,
    /// Canonical real Node install directory, replacing aliases.
    pub real_node: Option<WinPath>,
    /// Whether Cargo config must also be denied.
    pub cargo_config_has_token: bool,
    /// Existing Cargo directory entry names; all credentials* files are denied.
    pub cargo_entries: Vec<String>,
    /// Selected default compiler and Windows Kits evidence.
    pub msvc: Option<Msvc>,
}
/// Default MSVC version and Windows Kits version selected by vswhere/registry discovery.
#[derive(Clone, Debug)]
pub struct Msvc {
    /// Selected VC Tools MSVC version directory.
    pub tools: WinPath,
    /// Selected Windows Kits Lib version directory.
    pub kits_lib: WinPath,
    /// Compiler target architecture: x64, x86 or arm64.
    pub architecture: String,
    /// Cargo target triple.
    pub triple: String,
}
/// The exact read grants, ordered executable search path and extra tool environment.
#[derive(Clone, Debug, Default)]
pub struct Toolchain {
    /// Exact vetted read-only grants.
    pub readonly: Vec<WinPath>,
    /// Canonical PATH directories in host order.
    pub path: Vec<WinPath>,
    /// Credential and token-bearing config denials.
    pub denied: Vec<WinPath>,
    /// Explicit compiler variables (LIB and target linker).
    pub environment: BTreeMap<String, String>,
}
/// Selects only documented trusted install roots, replacing shims with the real Node install.
pub fn discover(input: &Discovery) -> Result<Toolchain, &'static str> {
    let mut result = Toolchain::default();
    let homes = trusted_homes(input)?;
    let git_cmd = vetted_git(input)?;
    if let Some(node) = &input.real_node {
        if !known_install(node, input) {
            return Err("Node outside known install root");
        }
        push(&mut result.path, node.clone());
        push(&mut result.readonly, node.clone());
    }
    add_cargo(&mut result, input)?;
    if let Some(cmd) = git_cmd {
        push(&mut result.path, cmd);
    }
    for dir in &input.path {
        if input.shim_dirs.iter().any(|shim| dir.is_within(shim))
            || dir.as_str().ends_with("\\windowsapps")
            || dir.as_str().ends_with("\\.nodejs")
        {
            continue;
        }
        if homes.iter().any(|home| dir.is_within(home))
            || python_home(dir, input.local_app_data.as_ref())?
        {
            push(&mut result.path, dir.clone());
        }
    }
    // Program Files roots qualify PATH entries; they are not themselves
    // broad grants. Cargo, rustup and Git need their complete install homes.
    result.readonly.extend(input.cargo_home.clone());
    result.readonly.extend(input.rustup_home.clone());
    result
        .readonly
        .extend(vetted_git(input)?.and_then(|cmd| cmd.parent()));
    for dir in &result.path {
        push(&mut result.readonly, dir.clone());
    }
    if let Some(msvc) = &input.msvc {
        add_msvc(&mut result, msvc)?;
    }
    Ok(result)
}
fn python_home(dir: &WinPath, local: Option<&WinPath>) -> Result<bool, &'static str> {
    let Some(local) = local else {
        return Ok(false);
    };
    let root = local.join("Programs\\Python")?;
    let Some(tail) = dir.as_str().strip_prefix(&format!("{}\\", root.as_str())) else {
        return Ok(false);
    };
    let home = tail.split('\\').next().unwrap_or_default();
    Ok(home
        .strip_prefix("python")
        .is_some_and(|version| !version.is_empty() && version.bytes().all(|b| b.is_ascii_digit())))
}
fn push(paths: &mut Vec<WinPath>, path: WinPath) {
    if !paths.contains(&path) {
        paths.push(path);
    }
}
fn add_msvc(result: &mut Toolchain, msvc: &Msvc) -> Result<(), &'static str> {
    if !["x64", "x86", "arm64"].contains(&msvc.architecture.as_str())
        || !msvc
            .triple
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid MSVC architecture or target");
    }
    let arch = &msvc.architecture;
    let bin = msvc.tools.join(&format!("bin\\Host{arch}\\{arch}"))?;
    let libs = [
        msvc.tools.join(&format!("lib\\{arch}"))?,
        msvc.kits_lib.join(&format!("ucrt\\{arch}"))?,
        msvc.kits_lib.join(&format!("um\\{arch}"))?,
    ];
    push(&mut result.path, bin.clone());
    push(&mut result.readonly, bin.clone());
    for lib in &libs {
        push(&mut result.readonly, lib.clone());
    }
    result.environment.insert(
        "LIB".into(),
        libs.iter()
            .map(WinPath::as_str)
            .collect::<Vec<_>>()
            .join(";"),
    );
    result.environment.insert(
        format!(
            "CARGO_TARGET_{}_LINKER",
            msvc.triple.replace('-', "_").to_ascii_uppercase()
        ),
        bin.join("link.exe")?.as_str().into(),
    );
    Ok(())
}

fn trusted_homes(input: &Discovery) -> Result<Vec<WinPath>, &'static str> {
    let mut homes = input.program_files.clone();
    homes.extend(input.system_root.clone());
    homes.extend(input.cargo_home.clone());
    homes.extend(input.rustup_home.clone());
    let git_cmd = vetted_git(input)?;
    if let Some(cmd) = &git_cmd {
        if !cmd.as_str().ends_with("\\cmd") {
            return Err("Git executable must be under cmd");
        }
        homes.extend(cmd.parent());
    }
    let npm = input.app_data.as_ref().map(|p| p.join("npm")).transpose()?;
    homes.extend(npm);
    Ok(homes)
}

fn add_cargo(result: &mut Toolchain, input: &Discovery) -> Result<(), &'static str> {
    let Some(cargo) = &input.cargo_home else {
        return Ok(());
    };
    push(&mut result.path, cargo.join("bin")?);
    result
        .denied
        .extend([cargo.join("credentials")?, cargo.join("credentials.toml")?]);
    for name in &input.cargo_entries {
        if name.contains(['/', '\\']) {
            return Err("invalid Cargo entry name");
        }
        if name.to_ascii_lowercase().starts_with("credentials") {
            push(&mut result.denied, cargo.join(name)?);
        }
    }
    if input.cargo_config_has_token {
        // Cargo also reads, and prefers, the legacy extensionless name.
        result
            .denied
            .extend([cargo.join("config")?, cargo.join("config.toml")?]);
    }
    Ok(())
}

fn known_install(path: &WinPath, input: &Discovery) -> bool {
    input
        .program_files
        .iter()
        .chain(&input.install_roots)
        .any(|root| path.is_within(root) && path != root)
}
fn vetted_git(input: &Discovery) -> Result<Option<WinPath>, &'static str> {
    let Some(exe) = &input.git_exe else {
        return Ok(None);
    };
    let cmd = exe.parent().ok_or("Git parent missing")?;
    let root = cmd.parent().ok_or("Git root missing")?;
    if !cmd.as_str().ends_with("\\cmd") || !known_install(&root, input) {
        return Err("Git outside known install root");
    }
    Ok(Some(cmd))
}
