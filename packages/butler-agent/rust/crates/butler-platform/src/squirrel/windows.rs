//! Per-user registrations target the stable Squirrel launcher.
use std::{
    os::windows::process::CommandExt,
    path::Path,
    process::{Command, Stdio},
};

use winsafe::{HKEY, RegistryValue, co};

use super::Event;
use crate::{app_shell, login_item};

const PROTOCOL_KEY: &str = r"Software\Classes\butler";
const COMMAND_KEY: &str = r"Software\Classes\butler\shell\open\command";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(super) fn handle(
    event: Event,
    executable: &Path,
    data: &Path,
    owned_data: bool,
) -> Result<(), String> {
    if std::env::var("BUTLER_APP_DISABLE_SHELL_REGISTRATION").as_deref() == Ok("1") {
        return Ok(());
    }
    let stub = app_shell::launcher(executable);
    if stub == executable {
        return Ok(());
    }
    let root = stub.parent().ok_or("Squirrel root unavailable")?;
    match event {
        Event::Install | Event::Updated => {
            register_protocol(&stub)?;
            shortcuts(&stub, root, true)?;
        }
        Event::Uninstall => {
            match login_item::set(executable, false) {
                Ok(()) | Err(login_item::LoginItemError::Unsupported) => {}
                Err(login_item::LoginItemError::Failed(_)) => {
                    return Err("Squirrel login item removal failed".into());
                }
            }
            unregister_protocol(&stub)?;
            shortcuts(&stub, root, false)?;
            delete_key(
                &format!(
                    r"Software\Classes\AppUserModelId\{}",
                    app_shell::WINDOWS_APP_ID
                ),
                "Squirrel notification removal failed",
            )?;
            if owned_data {
                remove_state(data)?;
            }
        }
        Event::Obsolete => {}
    }
    Ok(())
}

fn protocol_command(stub: &Path) -> Result<String, String> {
    let stub = stub.to_str().ok_or("Squirrel protocol path invalid")?;
    Ok(format!("\"{stub}\" \"%1\""))
}

fn register_protocol(stub: &Path) -> Result<(), String> {
    let command = protocol_command(stub)?;
    for (key, name, value) in [
        (PROTOCOL_KEY, None, "URL:butler".to_owned()),
        (PROTOCOL_KEY, Some("URL Protocol"), String::new()),
        (COMMAND_KEY, None, command),
    ] {
        HKEY::CURRENT_USER
            .RegSetKeyValue(Some(key), name, RegistryValue::Sz(value))
            .map_err(|_| "Squirrel protocol registration failed")?;
    }
    Ok(())
}

fn unregister_protocol(stub: &Path) -> Result<(), String> {
    let expected = protocol_command(stub)?;
    let command = HKEY::CURRENT_USER
        .RegOpenKeyEx(
            Some(COMMAND_KEY),
            co::REG_OPTION::NoValue,
            co::KEY::QUERY_VALUE,
        )
        .and_then(|key| key.RegQueryValueEx(None));
    match command {
        Ok(RegistryValue::Sz(value) | RegistryValue::ExpandSz(value)) if value == expected => {
            delete_key(PROTOCOL_KEY, "Squirrel protocol removal failed")
        }
        Ok(_) => Ok(()),
        Err(error) if missing_key(error) => Ok(()),
        Err(_) => Err("Squirrel protocol query failed".into()),
    }
}

fn missing_key(error: co::ERROR) -> bool {
    error == co::ERROR::FILE_NOT_FOUND || error == co::ERROR::PATH_NOT_FOUND
}

fn delete_key(key: &str, step: &str) -> Result<(), String> {
    match HKEY::CURRENT_USER.RegDeleteTree(Some(key)) {
        Ok(()) => Ok(()),
        Err(error) if missing_key(error) => Ok(()),
        Err(_) => Err(step.into()),
    }
}

fn remove_state(data: &Path) -> Result<(), String> {
    for directory in [data.join("app").join("runtime"), data.join("updates")] {
        match std::fs::remove_dir_all(directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Squirrel operational state removal failed".into()),
        }
    }
    Ok(())
}

fn shortcuts(stub: &Path, root: &Path, create: bool) -> Result<(), String> {
    let stub = stub.to_str().ok_or("Squirrel shortcut target invalid")?;
    let root = root.to_str().ok_or("Squirrel shortcut root invalid")?;
    let input = serde_json::to_string(&serde_json::json!({
        "target": stub,
        "workingDirectory": root,
    }))
    .map_err(|_| "Squirrel shortcut input failed")?;
    let action = if create {
        r"
        New-Item -ItemType Directory -Path $folder -Force | Out-Null
        $shortcut = $shell.CreateShortcut($path)
        $shortcut.TargetPath = [string]$config.target
        $shortcut.WorkingDirectory = [string]$config.workingDirectory
        $shortcut.IconLocation = ([string]$config.target + ',0')
        $shortcut.Description = 'Butler'
        $shortcut.Save()
        if (-not (Test-Path -LiteralPath $path)) { throw 'shortcut_create_failed' }
        "
    } else {
        r"
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
        if (Test-Path -LiteralPath $path) { throw 'shortcut_remove_failed' }
        "
    };
    let shell = if create {
        "$shell = New-Object -ComObject WScript.Shell"
    } else {
        ""
    };
    let script = format!(
        r"
        $ErrorActionPreference = 'Stop'
        $config = ConvertFrom-Json $env:BUTLER_WINDOWS_SHORTCUT_INPUT
        {shell}
        foreach ($name in @('Programs', 'Desktop')) {{
            $folder = [Environment]::GetFolderPath($name)
            if (-not $folder) {{ throw 'shortcut_folder_unavailable' }}
            $path = Join-Path $folder 'Butler.lnk'
            {action}
        }}
        "
    );
    let status = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .env_remove("PSModulePath")
        .env("BUTLER_WINDOWS_SHORTCUT_INPUT", input)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| "Squirrel shortcut launch failed")?;
    if status.success() {
        Ok(())
    } else {
        Err("Squirrel shortcut operation failed".into())
    }
}
