//! Discovery, authenticated API requests and resumable live events for native shells.
mod api;
mod attach;
mod events;
mod live_logs;
mod multipart;
mod transport;
mod types;

pub use events::LiveEvents;
pub use live_logs::LiveLogs;
pub use multipart::Upload;
pub use transport::ShellClient;
pub use types::{
    AttachState, AuthorityDecision, AuthorityPage, AuthorityRequest, Download, Error, EventKind,
    EventPage, FailureKind, LiveEvent, MessagePage, Page, PageRequest,
};
