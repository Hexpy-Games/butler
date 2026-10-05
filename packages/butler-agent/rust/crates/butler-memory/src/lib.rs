//! Long-term memory: what Butler remembers across sessions.
//!
//! [`cognition`] extracts memories from conversations into a SQLite graph and
//! LanceDB vectors, recalls them for context, and rebuilds memory generations;
//! [`profile`] maintains the user profile; [`work_records`] keeps durable
//! records of completed work; [`coordination`] serializes memory writers
//! across processes.

#![deny(missing_docs, clippy::indexing_slicing, clippy::unnecessary_wraps)]

#[macro_use]
extern crate butler_core;

pub mod cognition;
pub mod coordination;
pub mod management;
pub mod profile;
pub mod work_records;

mod js_json;
mod lenient;
