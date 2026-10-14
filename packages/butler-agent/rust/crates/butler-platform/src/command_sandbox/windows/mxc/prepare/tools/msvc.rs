//! Read-only compiler discovery; no installation or registry mutation.
use super::{Discovery, Error, environment, physical};
use crate::command_sandbox::mxc_policy::toolchain::Msvc;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

pub(super) fn discover(env: &BTreeMap<String, String>, input: &mut Discovery) -> Result<(), Error> {
    let Some(pf) = environment::get(env, "PROGRAMFILES(X86)") else {
        return Ok(());
    };
    let vswhere = Path::new(pf).join("Microsoft Visual Studio/Installer/vswhere.exe");
    if !vswhere.is_file() {
        return Ok(());
    }
    let output = Command::new(vswhere)
        .args([
            "-latest",
            "-products",
            "*",
            "-requires",
            "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
            "-property",
            "installationPath",
        ])
        .output()?;
    if !output.status.success() {
        return Err("vswhere_failed".into());
    }
    let install = String::from_utf8(output.stdout)?;
    let install = install.trim();
    if install.is_empty() {
        return Ok(());
    }
    let version = fs::read_to_string(
        Path::new(install).join("VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt"),
    )?;
    let tools = physical(
        &Path::new(install)
            .join("VC/Tools/MSVC")
            .join(version.trim()),
    )?;
    if !input.program_files.iter().any(|p| tools.is_within(p)) {
        return Err("msvc_untrusted_root".into());
    }
    let system = environment::get(env, "SYSTEMROOT").ok_or("SYSTEMROOT required")?;
    let output = Command::new(Path::new(system).join("System32/reg.exe"))
        .args([
            "query",
            "HKLM\\SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots",
            "/v",
            "KitsRoot10",
            "/reg:32",
        ])
        .output()?;
    if !output.status.success() {
        return Ok(());
    }
    let listing = String::from_utf8_lossy(&output.stdout);
    let Some(root) = listing
        .lines()
        .find_map(|line| line.split_once("REG_SZ").map(|(_, value)| value.trim()))
    else {
        return Ok(());
    };
    let root = PathBuf::from(root).join("Lib");
    let latest = fs::read_dir(&root)?
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir())
        .map(|e| e.path())
        .max();
    let Some(latest) = latest else {
        return Ok(());
    };
    let kits_lib = physical(&latest)?;
    if !input.program_files.iter().any(|p| kits_lib.is_within(p)) {
        return Err("kits_untrusted_root".into());
    }
    input.msvc = Some(Msvc {
        tools,
        kits_lib,
        architecture: "x64".into(),
        triple: "x86_64-pc-windows-msvc".into(),
    });
    Ok(())
}
