//! Inspect each live DACL through safe native bindings. Only process identity
//! is cached; paths, owners, access rules and inheritance are always re-read.
use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::{fs::OpenOptionsExt, process::CommandExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use windows_permissions::{
    LocalBox, SecurityDescriptor, Sid,
    constants::{AccessRights, AceType, SeObjectType, SecurityInformation},
    wrappers,
};

fn current_sid() -> io::Result<LocalBox<Sid>> {
    static SID: OnceLock<Result<String, String>> = OnceLock::new();
    let value = SID.get_or_init(|| process_sid().map_err(|error| error.to_string()));
    value
        .as_ref()
        .map_err(|message| io::Error::other(message.clone()))?
        .parse()
}

fn process_sid() -> io::Result<String> {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let output = Command::new(PathBuf::from(root).join("System32/whoami.exe"))
        .args(["/user", "/fo", "csv", "/nh"])
        .creation_flags(0x0800_0000)
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other("Could not resolve the process user SID"));
    }
    let output = String::from_utf8_lossy(&output.stdout);
    let value = output
        .trim()
        .rsplit(',')
        .next()
        .unwrap_or("")
        .trim_matches('"');
    let _: LocalBox<Sid> = value.parse()?;
    Ok(value.to_owned())
}

fn open(path: &Path, rights: AccessRights) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .access_mode(rights.bits())
        .custom_flags(0x0200_0000) // FILE_FLAG_BACKUP_SEMANTICS supports directories.
        .open(path)
}

pub(super) fn protect(path: &Path) -> io::Result<()> {
    let path = std::fs::canonicalize(path)?;
    let sid = current_sid()?;
    let mut file = open(&path, AccessRights::ReadControl | AccessRights::WriteDac)?;
    let current = wrappers::GetSecurityInfo(
        &file,
        SeObjectType::SE_FILE_OBJECT,
        SecurityInformation::Owner,
    )?;
    let owner_changes = current.owner() != Some(&*sid);
    if owner_changes {
        file = open(
            &path,
            AccessRights::ReadControl | AccessRights::WriteDac | AccessRights::WriteOwner,
        )?;
    }
    let inheritance = if file.metadata()?.is_dir() {
        "OICI"
    } else {
        ""
    };
    let sid_text = sid.to_string();
    let descriptor: LocalBox<SecurityDescriptor> =
        format!("O:{sid_text}D:P(A;{inheritance};FA;;;{sid_text})").parse()?;
    let mut fields = SecurityInformation::Dacl | SecurityInformation::ProtectedDacl;
    if owner_changes {
        fields |= SecurityInformation::Owner;
    }
    let dacl = descriptor
        .dacl()
        .ok_or_else(|| io::Error::other("Private DACL is missing"))?;
    wrappers::SetSecurityInfo(
        &mut file,
        SeObjectType::SE_FILE_OBJECT,
        fields,
        owner_changes.then_some(&*sid),
        None,
        Some(dacl),
        None,
    )
}

pub(super) fn inspect(path: &Path) -> io::Result<bool> {
    let file = open(&std::fs::canonicalize(path)?, AccessRights::ReadControl)?;
    let descriptor = wrappers::GetSecurityInfo(
        &file,
        SeObjectType::SE_FILE_OBJECT,
        SecurityInformation::Owner | SecurityInformation::Dacl,
    )?;
    let sid = current_sid()?;
    let administrators: LocalBox<Sid> = "S-1-5-32-544".parse()?;
    let system: LocalBox<Sid> = "S-1-5-18".parse()?;
    let owner = descriptor.owner();
    if owner != Some(&*sid) && owner != Some(&*administrators) && owner != Some(&*system) {
        return Ok(false);
    }
    let Some(acl) = descriptor.dacl() else {
        return Ok(false);
    };
    let mut readable = false;
    for index in 0..acl.len() {
        let Some(ace) = acl.get_ace(index) else {
            return Ok(false);
        };
        match ace.ace_type() {
            AceType::ACCESS_ALLOWED_ACE_TYPE
            | AceType::ACCESS_ALLOWED_OBJECT_ACE_TYPE
            | AceType::ACCESS_ALLOWED_CALLBACK_ACE_TYPE
            | AceType::ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE => {
                if ace.sid() != Some(&*sid) {
                    return Ok(false);
                }
                readable |= ace.mask().contains(AccessRights::Bit0);
            }
            AceType::ACCESS_DENIED_ACE_TYPE
            | AceType::ACCESS_DENIED_OBJECT_ACE_TYPE
            | AceType::ACCESS_DENIED_CALLBACK_ACE_TYPE
            | AceType::ACCESS_DENIED_CALLBACK_OBJECT_ACE_TYPE => {}
            _ => return Ok(false),
        }
    }
    Ok(readable)
}
