//! Typed renderer wire contracts; field names follow their TypeScript sources.
#![allow(
    dead_code,
    non_snake_case,
    clippy::struct_field_names,
    unused_imports,
    reason = "wire contracts are consumed by the upcoming screen batches and preserve TS field names"
)]

mod navigation;
pub(crate) use navigation::*;
mod session;
pub(crate) use session::*;
mod answers;
pub(crate) use answers::*;
mod queue;
pub(crate) use queue::*;
mod authority;
pub(crate) use authority::*;
mod misc;
pub(crate) use misc::*;
mod events;
pub(crate) use events::*;
mod projection;
pub(crate) use projection::*;
