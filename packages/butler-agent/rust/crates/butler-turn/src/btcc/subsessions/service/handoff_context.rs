//! Worker handoff of the user's own words, and recovery of superseded Workers.
use super::*;
use crate::btcc::SubsessionPacket;

impl SubsessionService {
    pub(super) async fn worker_user_request(
        &self,
        packet: &mut SubsessionPacket,
    ) -> Result<(), BtccError> {
        if let Some(parent) = self
            .repository
            .by_child(packet.parent_session_id.clone())
            .await?
        {
            packet.user_request = parent.packet.user_request;
        }
        Ok(())
    }

    pub(super) async fn recover_superseded_workers(&self) -> Result<(), BtccError> {
        for worker in self.repository.superseded_workers().await? {
            if self
                .repository
                .result_for_relation(worker.relation_id.clone())
                .await?
                .is_some()
                && !self
                    .repository
                    .worker_cancellable(worker.relation_id.clone())
                    .await?
            {
                continue;
            }
            self.cancel_by_relation(worker.parent_session_id, worker.relation_id, "superseded")
                .await?;
        }
        Ok(())
    }
}
