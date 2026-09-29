//! One module per `butler-agent` command family; [`command`] classifies argv
//! and dispatches to them.

pub(super) mod cognition;
pub(crate) mod command;
pub(super) mod consolidation;
pub(super) mod context;
pub(super) mod conversation_recovery;
pub(super) mod doctor;
pub(crate) mod error;
pub(super) mod gateway;
pub(super) mod oauth_login;
pub(super) mod observability;
pub(super) mod open;
pub(super) mod personalization;
pub(super) mod public;
pub(super) mod schedule;
pub(super) mod service;
pub(super) mod settings;
pub(super) mod skills;
pub(super) mod status;
pub(super) mod transport;
pub(super) mod update;
pub(super) mod web_access;
pub(super) mod work;
