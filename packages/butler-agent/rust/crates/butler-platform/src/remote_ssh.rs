//! The owner's OpenSSH client and its minimal inherited environment.
use std::collections::HashMap;

/// Resolve the owner's OpenSSH client from PATH.
pub const PROGRAM: &str = "ssh";

/// Inherit only the variables OpenSSH needs, with stable diagnostic language.
pub fn environment() -> HashMap<String, String> {
    #[cfg(unix)]
    let names = ["PATH", "HOME", "SSH_AUTH_SOCK", "USER", "LOGNAME"];
    #[cfg(windows)]
    let names = [
        "PATH",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "SystemRoot",
        "ProgramData",
        "USERNAME",
    ];
    let mut environment: HashMap<_, _> = names
        .into_iter()
        .filter_map(|name| std::env::var(name).ok().map(|value| (name.into(), value)))
        .collect();
    environment.insert("LC_ALL".into(), "C".into());
    environment
}
