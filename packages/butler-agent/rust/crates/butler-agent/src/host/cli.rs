//! One module per `butler-agent` command family; [`command`] classifies argv
//! and dispatches to them.

pub(crate) mod app_update;
pub(super) mod chatgpt_login;
pub(crate) mod command;
pub(super) mod doctor;
pub(crate) mod error;
pub(super) mod gateway;
mod http_logs;
pub(super) mod observability;
pub(super) mod open;
pub(super) mod public;
pub(super) mod remote;
pub(super) mod schedule;
pub(super) mod service;
pub(super) mod settings;
pub(super) mod skills;
pub(super) mod status;
mod status_memory;
pub(super) mod update;
