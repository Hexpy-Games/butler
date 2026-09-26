//! Public-web retrieval owns its service client and Turn-scoped page cache.

mod evidence;
mod html;
mod page;
mod planning;
mod providers;
mod read;
mod search;
mod service;
mod spool;

#[cfg(test)]
mod tests;

pub(crate) use service::{WebAccess, WebSession};
