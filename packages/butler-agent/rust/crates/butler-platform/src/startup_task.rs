//! The package startup task: start at login for an App installed as an MSIX
//! package. Windows owns the task and the user can also switch it in Windows
//! Settings, so every read asks Windows.

#[cfg(windows)]
mod windows;

/// Windows' current state of the package startup task.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartupTaskState {
    /// The task starts at login.
    Enabled,
    /// The task does not start at login.
    Disabled,
    /// The user disabled the task in Windows.
    DisabledByUser,
    /// Policy disabled the task.
    DisabledByPolicy,
    /// Policy enabled the task.
    EnabledByPolicy,
}

impl StartupTaskState {
    /// The state spelling returned to the App.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Enabled => "enabled",
            Self::Disabled => "disabled",
            Self::DisabledByUser => "disabled_by_user",
            Self::DisabledByPolicy => "disabled_by_policy",
            Self::EnabledByPolicy => "enabled_by_policy",
        }
    }
}

/// The state of the one startup task the current package declares.
/// Blocks; run off async workers.
pub fn state() -> Result<StartupTaskState, String> {
    #[cfg(windows)]
    {
        windows::state()
    }
    #[cfg(not(windows))]
    {
        Err("package startup tasks exist only on Windows".into())
    }
}

/// Requests enabling (Windows may refuse: disabled by user/policy) or disables it;
/// returns the resulting state. Blocks; run off async workers.
pub fn set(enabled: bool) -> Result<StartupTaskState, String> {
    #[cfg(windows)]
    {
        windows::set(enabled)
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("package startup tasks exist only on Windows".into())
    }
}
