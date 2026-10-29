//! Butler-authored conversation messages. Origins are open for S4/S5 kinds.
mod attention;
pub(super) use attention::enqueue_attention;
mod decisions;
mod failures;
mod gate;
mod outbox;
mod pause;
pub(super) mod posting;
mod projection;
mod proposals;
mod retry;
mod work;
pub(super) use failures::save_reply_quiet;

pub(super) use decisions::Decisions;
pub(super) use gate::{Composing, Gate, Hold};
pub(super) use projection::{origin, quiet};

pub(super) use proposals::public_proposals;
