//! Butler-authored conversation messages. Origins are open for S4/S5 kinds.
mod attention;
pub(super) use attention::enqueue_attention;
mod decisions;
mod gate;
mod outbox;
mod pause;
mod projection;
mod proposals;
mod work;

pub(super) use decisions::Decisions;
pub(super) use gate::{Composing, Hold};
pub(super) use projection::origin;

pub(super) use proposals::public_proposals;
