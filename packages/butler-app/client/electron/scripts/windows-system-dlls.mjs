// Inbox DLLs in System32 on every supported Windows x64 release, so the
// payload need not carry them. Anything else (a VC runtime, an ORT DLL) would
// be missing on a clean machine.
const WINDOWS_SYSTEM_DLLS = new Set([
  "advapi32.dll", "bcrypt.dll", "bcryptprimitives.dll", "cfgmgr32.dll",
  "combase.dll", "credui.dll", "crypt32.dll", "dbghelp.dll", "dnsapi.dll", "gdi32.dll", "iphlpapi.dll",
  "kernel32.dll", "mswsock.dll", "ncrypt.dll", "netapi32.dll", "ntdll.dll",
  "ole32.dll", "oleaut32.dll", "pdh.dll", "powrprof.dll", "propsys.dll", "psapi.dll",
  "rpcrt4.dll", "secur32.dll", "setupapi.dll", "shell32.dll", "shlwapi.dll",
  "synchronization.dll", "tdh.dll", "user32.dll", "userenv.dll", "uuid.dll",
  "version.dll", "winhttp.dll", "winmm.dll", "wintrust.dll", "ws2_32.dll",
  "wtsapi32.dll", "normaliz.dll",
]);

/** DLL names listed by `dumpbin /imports` (regular and delay-load). */
export function windowsImportedDlls(dumpbinImports) {
  return [...dumpbinImports.matchAll(/^\s+([\w.-]+\.dll)\s*$/gimu)]
    .map((match) => match[1].toLowerCase());
}

/** Imported DLLs that are neither inbox system DLLs nor API sets. */
export function unpackagedWindowsDlls(names) {
  return names.filter((name) => !WINDOWS_SYSTEM_DLLS.has(name) &&
    !/^(?:api|ext)-ms-win-[a-z0-9-]+\.dll$/u.test(name));
}
