//! Discovery, authenticated API requests and resumable live events for native shells.
mod api;
mod attach;
mod events;
mod transport;
mod types;

pub use events::LiveEvents;
pub use transport::ShellClient;
pub use types::{
    AttachState, AuthorityDecision, AuthorityPage, AuthorityRequest, Error, EventKind, EventPage,
    LiveEvent, MessagePage, Page, PageRequest,
};
