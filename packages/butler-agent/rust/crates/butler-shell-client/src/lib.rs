//! UI-independent, authenticated attachment to an already running local agent.
//! No process is started, and no default port is ever probed. Drop a live stream
//! to release its socket; it owns no background task. Payloads retain wire fields
//! so a later shell can render the same information as the Electron client.
#![deny(missing_docs)]
mod shell_connection;

pub use shell_connection::{
    AttachState, AuthorityDecision, AuthorityPage, AuthorityRequest, Error, EventKind, EventPage,
    LiveEvent, LiveEvents, MessagePage, Page, PageRequest, ShellClient,
};
