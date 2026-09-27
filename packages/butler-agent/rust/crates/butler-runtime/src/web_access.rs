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

#[cfg(any(test, feature = "test-support"))]
pub mod testing;
#[cfg(test)]
mod tests;

pub(crate) use error::WebAccessCode;
pub use service::{WebAccess, WebSession};
