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
        // SAFETY: no security descriptor or name is supplied. This owned event is
        // closed only after joining the drain thread.
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
        // SAFETY: Wake owns a live event until Drop, after the worker joins.
        if unsafe { SetEvent(self.0 as HANDLE) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}
impl Drop for Wake {
    fn drop(&mut self) {
        // SAFETY: this is the unique owned handle, and the worker has joined.
        unsafe {
            CloseHandle(self.0 as HANDLE);
        }
    }
}

pub struct Reader {
    pub(super) root: PathBuf,
    handle: HANDLE,
    event: HANDLE,
    overlapped: Box<OVERLAPPED>,
    buffer: Vec<u32>,
    config: Config,
    pending: bool,
    alive: bool,
    #[cfg(feature = "test-support")]
    pub(super) replenish: usize,
    #[cfg(feature = "test-support")]
    pub(super) rescan_reason: Option<&'static str>,
}
impl Reader {
    pub fn new(root: &Path, config: Config) -> io::Result<Self> {
        let path: Vec<_> = root.as_os_str().encode_wide().chain(Some(0)).collect();
        // SAFETY: path is NUL-terminated and remains live for the call; the
        // returned directory handle is uniquely owned by Reader.
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
        // SAFETY: null optional arguments; the returned event is owned here.
        let event = unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) };
        if event.is_null() {
            let error = io::Error::last_os_error();
            // SAFETY: ownership has not escaped; release the directory on failure.
            unsafe {
                CloseHandle(handle);
            }
            return Err(error);
        }
        let mut reader = Self {
            root: root.to_owned(),
            handle,
            event,
            // SAFETY: all-zero OVERLAPPED is valid before issuing any I/O.
            overlapped: Box::new(unsafe { std::mem::zeroed() }),
            buffer: vec![0; config.buffer_bytes.div_ceil(4)],
            config,
            pending: false,
            alive: true,
            #[cfg(feature = "test-support")]
            replenish: 0,
            #[cfg(feature = "test-support")]
            rescan_reason: None,
        };
        reader.arm()?;
        Ok(reader)
    }
    fn arm(&mut self) -> io::Result<()> {
        // SAFETY: the event is owned, and prior I/O has completed before rearming.
        unsafe {
            ResetEvent(self.event);
        }
        // SAFETY: no request owns this OVERLAPPED until ReadDirectoryChangesW.
        *self.overlapped = unsafe { std::mem::zeroed() };
        self.overlapped.hEvent = self.event;
        // SAFETY: buffer and boxed OVERLAPPED have stable storage through
        // completion/cancellation; Drop cancels and joins before freeing either.
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
        // SAFETY: both event handles remain owned for this wait.
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
            // SAFETY: this reader owns the request and its writable byte count.
            let ok = unsafe { GetOverlappedResult(self.handle, &*self.overlapped, &mut bytes, 0) };
            let code = if ok != 0 {
                ERROR_SUCCESS
            } else {
                // SAFETY: read the error from the immediately preceding failed call.
                unsafe { GetLastError() }
            };
            if code == ERROR_IO_INCOMPLETE {
                return Ok(());
            }
            self.pending = false;
            if code == ERROR_NOTIFY_ENUM_DIR || (code == ERROR_SUCCESS && bytes == 0) {
                #[cfg(feature = "test-support")]
                {
                    self.rescan_reason = Some("overflow");
                }
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
                #[cfg(feature = "test-support")]
                {
                    self.rescan_reason = Some("changes");
                }
                changes.clear();
                changes.push(Change::Rescan);
            }
            self.arm()?;
            #[cfg(feature = "test-support")]
            if self.replenish > 0 {
                self.replenish -= 1;
                std::fs::write(
                    self.root.join(format!("completion-{}", self.replenish)),
                    b"complete",
                )?;
                self.wait_completion()?;
            }
        }
        #[cfg(feature = "test-support")]
        {
            self.rescan_reason = Some("completions");
        }
        changes.clear();
        changes.push(Change::Rescan);
        Ok(())
    }
    fn decode(&self, bytes: usize, changes: &mut Vec<Change>) -> io::Result<()> {
        if bytes > self.buffer.len() * 4 {
            return Err(io::Error::other("invalid notification length"));
        }
        // SAFETY: the kernel completed this buffer; bytes was checked against
        // allocation size, and DWORD allocation guarantees alignment.
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
                .as_chunks::<2>()
                .0
                .iter()
                .map(|b| u16::from_le_bytes(*b))
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
        // SAFETY: cancel and wait for owned I/O before freeing OVERLAPPED/buffer;
        // then close both uniquely owned handles exactly once.
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

pub fn interactive_desktop() -> io::Result<bool> {
    use windows_sys::Win32::{
        System::StationsAndDesktops::*, UI::WindowsAndMessaging::WSF_VISIBLE,
    };
    // SAFETY: this is a borrowed process window station; it must not be closed.
    let station = unsafe { GetProcessWindowStation() };
    if station.is_null() {
        return Err(io::Error::last_os_error());
    }
    let mut flags = USEROBJECTFLAGS::default();
    // SAFETY: flags is a writable USEROBJECTFLAGS with its exact size. The
    // station remains owned by the process; the optional size output is unused.
    if unsafe {
        GetUserObjectInformationW(
            station,
            UOI_FLAGS,
            (&mut flags as *mut USEROBJECTFLAGS).cast(),
            std::mem::size_of::<USEROBJECTFLAGS>() as u32,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(flags.dwFlags & WSF_VISIBLE as u32 != 0)
}

#[cfg(feature = "test-support")]
impl Reader {
    pub(super) fn wait_completion(&self) -> io::Result<()> {
        // SAFETY: the reader owns this live event throughout the bounded wait.
        if unsafe { WaitForSingleObject(self.event, 2000) } != WAIT_OBJECT_0 {
            return Err(io::Error::other("fixture completion timed out"));
        }
        Ok(())
    }
}
