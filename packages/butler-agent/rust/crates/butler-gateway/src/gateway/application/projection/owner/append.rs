use super::*;

impl ProjectionOwner {
    pub(in crate::gateway::application) fn append_listener(
        &self,
    ) -> crate::gateway::TranscriptAppendListener {
        let owner = Arc::downgrade(&self.inner);
        Arc::new(move |file| {
            if let Some(owner) = owner.upgrade() {
                notifications::transcript(&owner.pending, &owner.sender, file.to_owned());
            }
        })
    }
    pub(in crate::gateway::application) fn settlement_listener(
        &self,
    ) -> crate::gateway::InboundSettlementListener {
        notifications::settlement_listener(&self.inner)
    }
}
