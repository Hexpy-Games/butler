//! The owner's OpenSSH client and its minimal inherited environment.
use std::collections::HashMap;

/// Resolve the owner's OpenSSH client from PATH.
pub const PROGRAM: &str = "ssh";

/// Names an OpenSSH config file that `ssh -G` reads instead of the account's own
/// (OpenSSH finds `~/.ssh` from the account database, not `HOME`). Honored only in test-support builds.
pub const CONFIG_FIXTURE: &str = "BUTLER_SSH_CONFIG_FIXTURE";

/// `-F <fixture>` in test-support builds when set; otherwise nothing.
pub fn settings_config_args() -> Vec<String> {
    #[cfg(feature = "test-support")]
    if let Some(path) = std::env::var_os(CONFIG_FIXTURE).filter(|v| !v.is_empty()) {
        return vec!["-F".into(), path.to_string_lossy().into_owned()];
    }
    Vec::new()
}

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
