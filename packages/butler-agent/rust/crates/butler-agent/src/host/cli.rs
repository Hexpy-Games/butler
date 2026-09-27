//! One module per `butler-agent` command family; [`command`] classifies argv
//! and dispatches to them.

#[cfg(unix)]
pub(super) mod automation;
#[cfg(unix)]
pub(super) mod cognition;
#[cfg(unix)]
pub(crate) mod command;
#[cfg(unix)]
pub(super) mod consolidation;
#[cfg(unix)]
pub(super) mod context;
#[cfg(unix)]
pub(super) mod conversation_recovery;
#[cfg(unix)]
pub(super) mod doctor;
pub(crate) mod error;
#[cfg(unix)]
pub(super) mod gateway;
#[cfg(unix)]
pub(super) mod oauth_login;
#[cfg(unix)]
pub(super) mod observability;
#[cfg(unix)]
pub(super) mod open;
#[cfg(unix)]
pub(super) mod personalization;
#[cfg(unix)]
pub(super) mod public;
#[cfg(unix)]
pub(super) mod service;
#[cfg(unix)]
pub(super) mod settings;
pub(super) mod skills;
#[cfg(unix)]
pub(super) mod status;
#[cfg(unix)]
pub(super) mod transport;
#[cfg(unix)]
pub(super) mod update;
#[cfg(unix)]
pub(super) mod web_access;
#[cfg(unix)]
pub(super) mod work;
