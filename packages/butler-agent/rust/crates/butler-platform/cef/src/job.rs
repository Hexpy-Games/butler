//! One kill-on-close Job Object, owned by the App, that every OSR CEF helper joins.
//!
//! The App creates it ([`ChildJob::create`]) before `cef::initialize` and keeps it for the
//! runtime's lifetime. The browser process appends `--butler-osr-job=<name>` and
//! `--butler-osr-app=<pid>` to each helper's command line and the helper joins the job first thing in [`join_from_command_line`]. The App
//! itself is never in the job. When its handle closes (the App ends, however it ends) Windows
//! ends every helper still in the job.
#![allow(unsafe_code, reason = "Job Object calls; see SAFETY comments")]

use std::ffi::c_void;
use std::hash::{BuildHasher, Hasher, RandomState};

use windows::Win32::Foundation::{
    CloseHandle, ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, GetLastError, HANDLE,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_BASIC_PROCESS_ID_LIST, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation, OpenJobObjectW,
    QueryInformationJobObject, SetInformationJobObject,
};
use windows::Win32::System::Threading::GetCurrentProcess;
use windows::core::PCWSTR;

/// `JOB_OBJECT_ASSIGN_PROCESS` (winnt.h): the right to assign a process to the job.
const JOB_OBJECT_ASSIGN_PROCESS: u32 = 0x1;

/// The App's job. Dropping it closes the handle, which ends every process still in the job.
pub(crate) struct ChildJob {
    handle: HANDLE,
    name: String,
}

impl ChildJob {
    /// Creates the job in the session-local namespace: `Local\butler-cef-<pid>-<random>`. Inside an
    /// AppContainer `Local\` resolves to the container's own namespace, so a helper outside it
    /// would find no job and exit under the rule in [`join_from_command_line`]. Today the OSR
    /// sandbox is off (null sandbox info), so App and helpers share one namespace.
    pub(crate) fn create() -> windows::core::Result<Self> {
        let random = RandomState::new().build_hasher().finish();
        let name = format!("Local\\butler-cef-{}-{random:016x}", std::process::id());
        let wide = wide(&name);
        // SAFETY: `wide` is NUL-terminated and outlives the call.
        let handle = unsafe { CreateJobObjectW(None, PCWSTR(wide.as_ptr())) }?;
        // An existing name returns a handle to that other job; ours must be a fresh one.
        // SAFETY: reads this thread's last error; nothing ran since the call above.
        let existed = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        let job = Self { handle, name };
        if existed {
            // Dropping `job` closes the handle.
            return Err(ERROR_ALREADY_EXISTS.into());
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: the handle is the job just created; `limits` is the struct the information
        // class names, and the size passed is its size.
        unsafe {
            SetInformationJobObject(
                job.handle,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast::<c_void>(),
                u32::try_from(size_of_val(&limits)).unwrap_or(u32::MAX),
            )
        }?;
        Ok(job)
    }

    pub(crate) fn name(&self) -> &str {
        &self.name
    }
}

impl Drop for ChildJob {
    fn drop(&mut self) {
        // SAFETY: the handle is owned by this value and closed once.
        let _ = unsafe { CloseHandle(self.handle) };
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

/// The value of `--<switch>=<value>` on this process's command line.
fn switch_value(switch: &str) -> Option<String> {
    let prefix = format!("--{switch}=");
    std::env::args_os().find_map(|arg| arg.to_str()?.strip_prefix(&prefix).map(str::to_owned))
}

/// In a helper: joins the App's job (`--butler-osr-job=<name>`, App pid in `--butler-osr-app`).
/// `Some(code)` is the exit code of a helper that must end at once; `None` means continue.
/// Helpers without the switch (the headless host's) are untouched.
pub(crate) fn join_from_command_line() -> Option<i32> {
    let name = switch_value(crate::switches::OSR_JOB)?;
    let app = switch_value(crate::switches::OSR_APP).and_then(|pid| pid.parse().ok());
    // One rule: join unless already in a job that does not hold the App. A job that holds the
    // App was inherited from it (the App itself runs in a job: cargo, a scheduler, CI), and
    // ours nests under it. Any other job is Chromium's own (network service, sandbox): nesting
    // ours under it would let Chromium closing that job (a network-service restart) end our
    // GPU process and renderers; those helpers already end with the browser through it.
    if app.is_some_and(|app| !joins(app)) {
        return None;
    }
    let error = match join(&name) {
        Ok(()) => return None,
        Err(error) => error,
    };
    if error.code() == ERROR_FILE_NOT_FOUND.to_hresult() {
        eprintln!("the App's job {name} is gone; exiting");
        return Some(3);
    }
    eprintln!("could not join the App's job {name}: {error}");
    None
}

/// Whether this process should join the App's job: it is in no job (the query fails or lists no
/// one), or its own (innermost) job holds the App's process. When the job cannot be read it
/// joins: a helper that outlives the App is the bug this prevents.
fn joins(app: u32) -> bool {
    let mut capacity = 512;
    for _ in 0..3 {
        // The header (two u32) takes one `usize` slot on 64-bit, two on 32-bit; the ids follow.
        let mut buffer = vec![0_usize; capacity + 2];
        let bytes = u32::try_from(buffer.len() * size_of::<usize>()).unwrap_or(u32::MAX);
        // SAFETY: `buffer` holds `bytes` bytes, aligned for the list struct; a null job handle
        // names the calling process's own job.
        let queried = unsafe {
            QueryInformationJobObject(
                None,
                JobObjectBasicProcessIdList,
                buffer.as_mut_ptr().cast::<c_void>(),
                bytes,
                None,
            )
        };
        let list = buffer.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>();
        // SAFETY: `buffer` is zeroed, so the header is readable whether or not the call wrote it
        // (it does on success and on ERROR_MORE_DATA). It holds at least `capacity` ids after the
        // 8-byte header on 32- and 64-bit and `listed` is at most `capacity`, so the slice lies
        // inside it; the id pointer is taken without a reference to the one-id array field.
        let (assigned, ids) = unsafe {
            let listed = ((*list).NumberOfProcessIdsInList as usize).min(capacity);
            (
                (*list).NumberOfAssignedProcesses as usize,
                std::slice::from_raw_parts(
                    (&raw const (*list).ProcessIdList).cast::<usize>(),
                    listed,
                ),
            )
        };
        match queried {
            // A process in a job is always in its own list: an empty one means no job.
            Ok(()) => return ids.is_empty() || ids.contains(&(app as usize)),
            Err(error) if error.code() == ERROR_MORE_DATA.to_hresult() => capacity = assigned + 16,
            Err(_) => return true,
        }
    }
    true
}

fn join(name: &str) -> windows::core::Result<()> {
    let wide = wide(name);
    // SAFETY: `wide` is NUL-terminated and outlives the call.
    let job = unsafe { OpenJobObjectW(JOB_OBJECT_ASSIGN_PROCESS, false, PCWSTR(wide.as_ptr())) }?;
    // SAFETY: `job` is the open handle above; GetCurrentProcess is a pseudo handle.
    let assigned = unsafe { AssignProcessToJobObject(job, GetCurrentProcess()) };
    // SAFETY: `job` is owned here and closed once.
    let _ = unsafe { CloseHandle(job) };
    assigned
}
