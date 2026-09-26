use std::sync::Arc;

use crate::btcc::{AuthorityPort, BtccError, GuidedInvocation, GuidedPresentation, PortFuture};
use crate::host::NativeGuidedActivity;

pub(super) struct NativeBoundAuthority {
    turn_id: String,
    activity: Arc<NativeGuidedActivity>,
}

impl NativeBoundAuthority {
    pub(super) fn new(turn_id: String, activity: Arc<NativeGuidedActivity>) -> Self {
        Self { turn_id, activity }
    }
}

impl AuthorityPort for NativeBoundAuthority {
    fn presentation<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
    ) -> PortFuture<'a, Option<GuidedPresentation>> {
        Box::pin(async move {
            if invocation.turn.turn_id != self.turn_id {
                return Err(BtccError::relayed(
                    "guided_authority_turn_mismatch",
                    "Activity owner belongs to a different Turn",
                ));
            }
            Ok(Some(GuidedPresentation {
                source_revision: self.activity.source_revision(),
                activity: self.activity.snapshot(),
            }))
        })
    }
}
