//! Weak callbacks for durable runtime changes observed by the App projection.
use super::super::AppApplication;

impl AppApplication {
    pub fn transcript_append_listener(&self) -> crate::gateway::TranscriptAppendListener {
        self.projection.append_listener()
    }

    pub fn inbound_settlement_listener(&self) -> crate::gateway::InboundSettlementListener {
        self.projection.settlement_listener()
    }
}
