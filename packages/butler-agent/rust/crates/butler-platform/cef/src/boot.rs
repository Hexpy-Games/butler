/// CEF's `bootstrapc.exe`, renamed `butler_cef_host.exe`, loads this DLL and calls this with the sandbox it created.
/// SAFETY: exported under the exact name and C signature of `RunConsoleMain` in CEF's include/cef_sandbox_win.h;
/// the arguments are only passed through to CEF.
#[allow(unsafe_code, reason = "the CEF bootstrap entry point; see SAFETY")]
#[allow(non_snake_case, reason = "the CEF bootstrap export name")]
#[unsafe(no_mangle)]
pub(crate) extern "C" fn RunConsoleMain(
    _argc: i32,
    _argv: *mut *mut i8,
    sandbox_info: *mut u8,
    _version_info: *mut u8,
) -> i32 {
    crate::run(sandbox_info)
}
