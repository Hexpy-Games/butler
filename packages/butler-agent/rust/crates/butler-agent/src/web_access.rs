//! Public-web retrieval owns its service client and Turn-scoped page cache.

mod error;
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
pub(crate) mod tests;

pub(crate) use error::WebAccessCode;
pub(crate) use service::{WebAccess, WebSession};
