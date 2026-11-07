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
mod question_answer;
pub(crate) use question_answer::*;
mod plan_decision;
pub(crate) use plan_decision::*;
mod browser_stills;
pub(crate) use browser_stills::*;
mod canon_proposal;
pub(crate) use canon_proposal::*;
mod palette;
pub(crate) use palette::*;
mod task_graph;
pub(crate) use task_graph::*;
mod new_chat;
pub(crate) use new_chat::*;
mod session_info;
pub(crate) use session_info::*;
