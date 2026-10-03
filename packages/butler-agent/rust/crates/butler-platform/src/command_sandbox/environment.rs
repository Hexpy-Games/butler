//! Allowlisted environment for user command tools. Windows variable names are
//! case-insensitive, including when collected into a case-sensitive Rust map.
use std::collections::HashMap;

const COMMON: &[&str] = &[
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "USERNAME",
    "HOMEDRIVE",
    "HOMEPATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LC_MESSAGES",
    "SHELL",
    "BUTLER_BUN",
    "BUTLER_WINDOWS_PROCESS_HOST",
];
// Drive and Program/CommonProgram roots: native executable/DLL discovery.
// Processor count/architecture and OS: Windows/.NET runtime initialization.
// PSModulePath: standard installed PowerShell modules (no profile execution).
#[cfg(windows)]
const WINDOWS: &[&str] = &[
    "SystemDrive",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "CommonProgramFiles",
    "CommonProgramFiles(x86)",
    "CommonProgramW6432",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
    "PSModulePath",
];

/// Copies only tool allowlisted variables. Credentials and arbitrary host
/// variables never pass to a command. Windows matching ignores ASCII case.
pub fn tool_environment(host: &HashMap<String, String>) -> HashMap<String, String> {
    let mut result = HashMap::new();
    for key in COMMON {
        if let Some(value) = value(host, key) {
            result.insert((*key).to_owned(), value.clone());
        }
    }
    #[cfg(windows)]
    {
        for key in WINDOWS {
            if let Some(value) = value(host, key) {
                result.insert((*key).to_owned(), value.clone());
            }
        }
        // Python pipes otherwise use the legacy ANSI page even when the
        // surrounding PowerShell console is UTF-8.
        result.insert("PYTHONIOENCODING".into(), "utf-8".into());
        result.insert("PYTHONUTF8".into(), "1".into());
    }
    result
}

fn value<'a>(host: &'a HashMap<String, String>, key: &str) -> Option<&'a String> {
    #[cfg(windows)]
    {
        host.iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(key))
            .map(|(_, value)| value)
    }
    #[cfg(not(windows))]
    {
        host.get(key)
    }
}
