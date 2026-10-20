//! Private fixture DACL denial with handle-based restoration.
use std::{fs::File, io, os::windows::fs::OpenOptionsExt, path::Path};
use windows_permissions::{
    LocalBox, SecurityDescriptor,
    constants::{SeObjectType, SecurityInformation},
    wrappers,
};

const READ_CONTROL: u32 = 0x0002_0000;
const WRITE_DAC: u32 = 0x0004_0000;

struct Restore {
    file: File,
    original: LocalBox<SecurityDescriptor>,
}

impl Restore {
    fn restore(&mut self) -> io::Result<()> {
        wrappers::SetSecurityInfo(
            &mut self.file,
            SeObjectType::SE_FILE_OBJECT,
            SecurityInformation::Dacl,
            None,
            None,
            self.original.dacl(),
            None,
        )
    }
}

impl Drop for Restore {
    fn drop(&mut self) {
        let _ = self.restore();
    }
}

pub(super) fn with_read_denied<T>(path: &Path, action: impl FnOnce() -> T) -> io::Result<T> {
    let file = File::options()
        .read(true)
        .access_mode(READ_CONTROL | WRITE_DAC)
        .open(path)?;
    let original = wrappers::GetSecurityInfo(
        &file,
        SeObjectType::SE_FILE_OBJECT,
        SecurityInformation::Dacl,
    )?;
    let mut restore = Restore { file, original };
    // No allow ACEs are added: only the disposable fixture loses read access.
    let denied: LocalBox<SecurityDescriptor> = "D:(D;;FA;;;WD)".parse()?;
    wrappers::SetSecurityInfo(
        &mut restore.file,
        SeObjectType::SE_FILE_OBJECT,
        SecurityInformation::Dacl,
        None,
        None,
        denied.dacl(),
        None,
    )?;
    let result = action();
    restore.restore()?;
    Ok(result)
}
