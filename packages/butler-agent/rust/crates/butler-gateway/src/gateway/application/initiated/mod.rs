//! Butler-authored conversation messages. Origins are open for S4/S5 kinds.
mod attention;
pub(super) use attention::enqueue_attention;
mod decisions;
mod failures;
mod gate;
mod outbox;
pub(in crate::gateway::application) use outbox::{
    enqueue as enqueue_canon, update_payload as update_canon_payload,
};
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
