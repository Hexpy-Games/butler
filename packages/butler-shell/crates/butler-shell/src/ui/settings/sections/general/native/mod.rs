//! The General fields that need what only the Electron main process had: the notification
//! permission panel, start at login, rerun setup and the full reset. Each is its own file.
pub(super) mod full_reset;
pub(super) mod login;
pub(super) mod notifications;
pub(super) mod rerun;
