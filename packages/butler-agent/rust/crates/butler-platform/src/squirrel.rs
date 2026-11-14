//! Squirrel's short-lived Windows install, update and uninstall launches.
use std::{ffi::OsString, path::Path};

#[cfg(windows)]
mod windows;

/// An install lifecycle launch, handled before starting the App.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    /// Register the new install.
    Install,
    /// Refresh registrations after an update.
    Updated,
    /// Remove this install's registrations and owned operational state.
    Uninstall,
    /// An old version is being retired; no registration work.
    Obsolete,
}

/// The Squirrel lifecycle event this process was started for (Windows only; None elsewhere).
pub fn event(args: &[OsString]) -> Option<Event> {
    #[cfg(windows)]
    return args.iter().skip(1).find_map(|arg| match arg.to_str()? {
        "--squirrel-install" => Some(Event::Install),
        "--squirrel-updated" => Some(Event::Updated),
        "--squirrel-uninstall" => Some(Event::Uninstall),
        "--squirrel-obsolete" => Some(Event::Obsolete),
        _ => None,
    });
    #[cfg(not(windows))]
    {
        let _ = args;
        None
    }
}

/// Does the event's shell registration for the install `executable` belongs to.
/// `owned_data`: the profile owns `data` (no explicit data root), so uninstall may remove its operational state.
pub fn handle(
    event: Event,
    executable: &Path,
    data: &Path,
    owned_data: bool,
) -> Result<(), String> {
    #[cfg(windows)]
    return windows::handle(event, executable, data, owned_data);
    #[cfg(not(windows))]
    {
        let _ = (event, executable, data, owned_data);
        Ok(())
    }
}
