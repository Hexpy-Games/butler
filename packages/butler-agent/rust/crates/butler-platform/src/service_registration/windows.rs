//! Per-user Task Scheduler registration. A temporary HOME does not isolate it.
use super::{Activation, Definition, Error, Job, Manager, Registration, Removal, Status, task_xml};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

pub(super) const MANAGER: Manager = Manager::TaskScheduler;

fn run(program: &str, args: &[&str]) -> Result<Output, Error> {
    Ok(Command::new(program)
        .args(args)
        .creation_flags(0x0800_0000)
        .output()?)
}

fn checked(program: &str, args: &[&str]) -> Result<Output, Error> {
    let output = run(program, args)?;
    if output.status.success() {
        return Ok(output);
    }
    Err(Error::Manager {
        command: program.into(),
        message: String::from_utf8_lossy(&output.stderr).trim().into(),
    })
}

fn powershell(script: &str) -> Result<Output, Error> {
    checked(
        "powershell.exe",
        &["-NoProfile", "-NonInteractive", "-Command", script],
    )
}

fn sid() -> Result<String, Error> {
    let output = powershell("[Security.Principal.WindowsIdentity]::GetCurrent().User.Value")?;
    let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if !value.starts_with("S-1-")
        || !value
            .chars()
            .all(|c| c.is_ascii_digit() || c == 'S' || c == '-')
    {
        return Err(Error::InvalidValue);
    }
    Ok(value)
}

fn task_name(sid: &str) -> String {
    format!("ButlerAgent-{sid}")
}

pub(super) fn definition_path() -> Result<PathBuf, Error> {
    Ok(crate::user_dirs::agent_home()
        .ok_or(Error::NoHome)?
        .join("startup-task.xml"))
}

fn read_local() -> Result<Option<String>, Error> {
    match std::fs::read(definition_path()?) {
        Ok(bytes) => Ok(Some(task_xml::decode(&bytes)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn query(sid: &str) -> Result<Option<String>, Error> {
    let name = task_name(sid);
    // schtasks with CREATE_NO_WINDOW exports through the OEM code page and
    // loses Unicode paths. The scheduler's BSTR stays intact through UTF-8.
    let script = format!(
        "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$ErrorActionPreference='Stop';try{{$s=New-Object -ComObject Schedule.Service;$s.Connect();[Console]::Write($s.GetFolder('\\').GetTask('{name}').Xml)}}catch{{if(($_.Exception.GetBaseException().HResult -band 65535) -eq 2){{exit 3}};[Console]::Error.WriteLine('Task Scheduler query failed');exit 1}}"
    );
    let output = run(
        "powershell.exe",
        &["-NoProfile", "-NonInteractive", "-Command", &script],
    )?;
    if output.status.success() {
        return Ok(Some(task_xml::decode(&output.stdout)?));
    }
    // Never interpret access-denied or other scheduler failures as absence.
    if output.status.code() == Some(3) {
        return Ok(None);
    }
    Err(Error::Manager {
        command: "Task Scheduler query".into(),
        message: String::from_utf8_lossy(&output.stderr).trim().into(),
    })
}

fn owned(sid: &str) -> Result<Option<String>, Error> {
    let Some(remote) = query(sid)? else {
        return Ok(None);
    };
    let identity = powershell(
        "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Security.Principal.WindowsIdentity]::GetCurrent().Name",
    )?;
    let account = String::from_utf8_lossy(&identity.stdout);
    let remote = task_xml::normalize_current_user(&remote, sid, account.trim()).unwrap_or(remote);
    let local = read_local()?.unwrap_or_default();
    if !task_xml::same_owner(&local, &remote, sid) {
        return Err(Error::Foreign(PathBuf::from(task_name(sid))));
    }
    Ok(Some(remote))
}

pub(super) fn render(definition: &Definition) -> Result<String, Error> {
    let shell = PathBuf::from(std::env::var_os("SystemRoot").ok_or(Error::InvalidValue)?)
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    task_xml::render(definition, &sid()?, &shell.to_string_lossy())
}

pub(super) fn install(
    definition: &Definition,
    activation: Activation,
) -> Result<Registration, Error> {
    let path = definition_path()?;
    let user = sid()?;
    let existing = if activation == Activation::Load {
        owned(&user)?
    } else {
        None
    };
    let previous = match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    let shell = PathBuf::from(std::env::var_os("SystemRoot").ok_or(Error::InvalidValue)?)
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut definition = definition.clone();
    inherit_profile(&mut definition);
    let xml = task_xml::render(&definition, &user, &shell.to_string_lossy())?;
    crate::secure_fs::create_private_dir_all(path.parent().ok_or(Error::InvalidValue)?)?;
    std::fs::write(&path, task_xml::encode(&xml))?;
    if activation == Activation::Load {
        let path_text = path.to_string_lossy();
        let name = task_name(&user);
        let mut args = vec!["/Create", "/TN", &name, "/XML", &path_text];
        if existing.is_some() {
            args.push("/F");
        }
        if let Err(error) = checked("schtasks.exe", &args) {
            if let Some(previous) = previous {
                std::fs::write(&path, previous)?;
            } else {
                std::fs::remove_file(&path)?;
            }
            return Err(error);
        }
        start()?;
    }
    Ok(Registration {
        manager: MANAGER,
        definition: path,
        loaded: activation == Activation::Load,
    })
}

pub(super) fn uninstall(activation: Activation) -> Result<Removal, Error> {
    let mut unloaded = false;
    if activation == Activation::Load {
        let user = sid()?;
        if owned(&user)?.is_some() {
            checked("schtasks.exe", &["/Delete", "/TN", &task_name(&user), "/F"])?;
            unloaded = true;
        }
    }
    let definition_removed = match std::fs::remove_file(definition_path()?) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(e.into()),
    };
    Ok(Removal {
        definition_removed,
        unloaded,
    })
}

pub(super) fn status() -> Result<Status, Error> {
    let remote = owned(&sid()?)?;
    let loaded = remote
        .as_deref()
        .and_then(task_xml::parse)
        .is_some_and(|task| task.enabled);
    Ok(Status {
        manager: MANAGER,
        definition: definition_path()?,
        registered: remote.is_some(),
        loaded: Some(loaded),
        running: None,
    })
}

pub(super) fn is_owned_by(directory: &Path) -> Result<bool, Error> {
    let remote = match registered_text() {
        Ok(remote) => remote,
        Err(Error::Foreign(_)) => return Ok(false),
        Err(e) => return Err(e),
    };
    Ok(remote
        .as_deref()
        .and_then(task_xml::parse)
        .is_some_and(|task| task.definition.program.starts_with(directory)))
}

pub(super) fn job() -> Result<Job, Error> {
    let status = status()?;
    Ok(Job {
        loaded: status.loaded == Some(true),
        pid: None,
        reachable: true,
    })
}

fn action(verb: &str) -> Result<(), Error> {
    let user = sid()?;
    owned(&user)?.ok_or(Error::NotRegistered)?;
    checked("schtasks.exe", &[verb, "/TN", &task_name(&user)])?;
    Ok(())
}

pub(super) fn start() -> Result<(), Error> {
    action("/Run")
}
pub(super) fn stop() -> Result<(), Error> {
    action("/End")
}
pub(super) fn restart() -> Result<(), Error> {
    stop()?;
    start()
}
pub(super) fn restart_detached() -> Result<bool, Error> {
    Ok(false)
}
pub(super) fn arguments(text: &str) -> Vec<String> {
    task_xml::parse(text)
        .map(|task| {
            std::iter::once(task.definition.program.to_string_lossy().into_owned())
                .chain(task.definition.args)
                .collect()
        })
        .unwrap_or_default()
}

// Lifecycle callers must inspect the scheduler's definition, not a stale local copy.
pub(super) fn registered_text() -> Result<Option<String>, Error> {
    if super::manager_disabled() {
        read_local()
    } else {
        owned(&sid()?)
    }
}

// Scheduler actions inherit the user's login environment, not this terminal's
// profile overrides. Preserve the profile used by the installing command.
pub(super) fn inherit_profile(definition: &mut Definition) {
    for name in ["HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA"] {
        if definition.env.iter().any(|(key, _)| key == name) {
            continue;
        }
        if let Some(value) = std::env::var(name).ok().filter(|value| !value.is_empty()) {
            definition.env.push((name.to_owned(), value));
        }
    }
}
