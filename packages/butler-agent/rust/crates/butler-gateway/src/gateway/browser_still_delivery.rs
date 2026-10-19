//! Durable desktop evidence keyed to the dispatch that produced it.
use bytes::Bytes;

pub enum AppBrowserStillCommand {
    Reserve {
        id: String,
        session: String,
        tab: String,
        count: usize,
    },
    Read {
        id: String,
        session: String,
    },
    Finish {
        id: String,
        session: String,
        awaiting: Vec<usize>,
    },
    Attach {
        id: String,
        session: String,
        tab: String,
        step: usize,
        bytes: Bytes,
    },
    Fail {
        id: String,
        session: String,
        step: usize,
        reason: String,
    },
    Recover {
        reason: String,
    },
}
