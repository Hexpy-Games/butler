//! FFI ownership adapted from notify's ReadDirectoryChangesW implementation.
use super::{Change, Config};
use std::{
    ffi::OsString,
    io,
    os::windows::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
    ptr,
};
use windows_sys::Win32::{
    Foundation::*,
    Storage::FileSystem::*,
    System::{IO::*, Threading::*},
};

pub struct Wake(usize);
impl Wake {
    pub fn new() -> io::Result<Self> {
        // Auto-reset control event, closed only after joining the drain thread.
        let event = unsafe { CreateEventW(ptr::null(), 0, 0, ptr::null()) };
        if event.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(event as usize))
    }
    pub fn id(&self) -> usize {
        self.0
    }
    pub fn signal(&self) -> io::Result<()> {
        if unsafe { SetEvent(self.0 as HANDLE) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}
impl Drop for Wake {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0 as HANDLE);
        }
    }
}

pub struct Reader {
    root: PathBuf,
    handle: HANDLE,
    event: HANDLE,
    overlapped: Box<OVERLAPPED>,
    buffer: Vec<u32>,
    config: Config,
    pending: bool,
    alive: bool,
}
impl Reader {
    pub fn new(root: &Path, config: Config) -> io::Result<Self> {
        let path: Vec<_> = root.as_os_str().encode_wide().chain(Some(0)).collect();
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                FILE_LIST_DIRECTORY,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
                ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let event = unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) };
        if event.is_null() {
            let error = io::Error::last_os_error();
            unsafe {
                CloseHandle(handle);
            }
            return Err(error);
        }
        let mut reader = Self {
            root: root.to_owned(),
            handle,
            event,
            overlapped: Box::new(unsafe { std::mem::zeroed() }),
            buffer: vec![0; config.buffer_bytes.div_ceil(4)],
            config,
            pending: false,
            alive: true,
        };
        reader.arm()?;
        Ok(reader)
    }
    fn arm(&mut self) -> io::Result<()> {
        unsafe {
            ResetEvent(self.event);
        }
        *self.overlapped = unsafe { std::mem::zeroed() };
        self.overlapped.hEvent = self.event;
        let result = unsafe {
            ReadDirectoryChangesW(
                self.handle,
                self.buffer.as_mut_ptr().cast(),
                (self.buffer.len() * 4) as u32,
                1,
                self.config.flags,
                ptr::null_mut(),
                &mut *self.overlapped,
                None,
            )
        };
        if result == 0 {
            self.alive = false;
            return Err(io::Error::last_os_error());
        }
        self.pending = true;
        Ok(())
    }
    pub fn alive(&self) -> bool {
        self.alive
    }
    pub fn wait(&self, wake: usize) -> io::Result<()> {
        let handles = [self.event, wake as HANDLE];
        let result = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, INFINITE) };
        if result == WAIT_FAILED {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    pub fn drain(&mut self, changes: &mut Vec<Change>) -> io::Result<()> {
        // A bounded queue fails closed on floods instead of exhausting process memory.
        for _ in 0..64 {
            if !self.pending {
                return Ok(());
            }
            let mut bytes = 0;
            let ok = unsafe { GetOverlappedResult(self.handle, &*self.overlapped, &mut bytes, 0) };
            let code = if ok != 0 {
                ERROR_SUCCESS
            } else {
                unsafe { GetLastError() }
            };
            if code == ERROR_IO_INCOMPLETE {
                return Ok(());
            }
            self.pending = false;
            if code == ERROR_NOTIFY_ENUM_DIR || (code == ERROR_SUCCESS && bytes == 0) {
                changes.clear();
                changes.push(Change::Rescan);
            } else if code == ERROR_SUCCESS {
                if let Err(error) = self.decode(bytes as usize, changes) {
                    self.alive = false;
                    return Err(error);
                }
            } else {
                self.alive = false;
                return Err(io::Error::from_raw_os_error(code as i32));
            }
            if changes.len() > 100_000 {
                changes.clear();
                changes.push(Change::Rescan);
            }
            self.arm()?;
        }
        changes.clear();
        changes.push(Change::Rescan);
        Ok(())
    }
    fn decode(&self, bytes: usize, changes: &mut Vec<Change>) -> io::Result<()> {
        if bytes > self.buffer.len() * 4 {
            return Err(io::Error::other("invalid notification length"));
        }
        // The kernel completed this buffer; DWORD allocation guarantees alignment.
        let buffer =
            unsafe { std::slice::from_raw_parts(self.buffer.as_ptr().cast::<u8>(), bytes) };
        let mut offset = 0;
        loop {
            let header = buffer
                .get(offset..offset + 12)
                .ok_or_else(|| io::Error::other("short notification"))?;
            let word =
                |i| u32::from_le_bytes([header[i], header[i + 1], header[i + 2], header[i + 3]]);
            let (next, action, length) = (word(0) as usize, word(4), word(8) as usize);
            if length % 2 != 0 {
                return Err(io::Error::other("odd notification name"));
            }
            let name = buffer
                .get(offset + 12..offset + 12 + length)
                .ok_or_else(|| io::Error::other("short name"))?;
            let wide: Vec<_> = name
                .chunks_exact(2)
                .map(|b| u16::from_le_bytes([b[0], b[1]]))
                .collect();
            let path = self.root.join(OsString::from_wide(&wide));
            match action {
                FILE_ACTION_ADDED | FILE_ACTION_RENAMED_NEW_NAME => {
                    changes.push(Change::Added(path))
                }
                FILE_ACTION_REMOVED | FILE_ACTION_RENAMED_OLD_NAME => {
                    changes.push(Change::Removed(path))
                }
                _ => changes.push(Change::Rescan),
            }
            if next == 0 {
                break;
            }
            if next < 12 + length {
                return Err(io::Error::other("invalid notification offset"));
            }
            offset += next;
        }
        Ok(())
    }
}
impl Drop for Reader {
    fn drop(&mut self) {
        // Neither OVERLAPPED nor its buffer may move or drop while the OS owns it.
        unsafe {
            if self.pending {
                CancelIoEx(self.handle, &*self.overlapped);
                let mut bytes = 0;
                GetOverlappedResult(self.handle, &*self.overlapped, &mut bytes, 1);
            }
            CloseHandle(self.handle);
            CloseHandle(self.event);
        }
    }
}
