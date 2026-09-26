use sha2::{Digest, Sha256};

use crate::conversation::ConversationLocaleCollation;
use crate::conversation::types::{
    ConversationOriginDecision, ConversationOriginEvidence, ConversationOriginKind,
};

pub(crate) struct ConversationOriginFacts {
    pub reference: Option<String>,
    pub public_ingress: bool,
    pub internal_control: bool,
    pub evidence_available: bool,
    pub evidence: Vec<ConversationOriginEvidence>,
}

pub(crate) fn classify_conversation_origin(
    collation: &dyn ConversationLocaleCollation,
    mut facts: ConversationOriginFacts,
) -> ConversationOriginDecision {
    facts.evidence.sort_by(|a, b| {
        collation.compare(
            &format!("{}\0{}", a.kind, a.reference),
            &format!("{}\0{}", b.kind, b.reference),
        )
    });
    let (kind, reason, complete) = if facts.internal_control {
        (
            ConversationOriginKind::InternalControl,
            "verified_internal_control",
            true,
        )
    } else if facts.public_ingress {
        (
            ConversationOriginKind::UserInput,
            "verified_public_ingress",
            true,
        )
    } else {
        (
            ConversationOriginKind::Unknown,
            if facts.evidence_available {
                "historical_origin_unresolved"
            } else {
                "historical_origin_evidence_unavailable"
            },
            facts.evidence_available,
        )
    };
    ConversationOriginDecision {
        kind,
        reference: facts.reference,
        reason: reason.into(),
        version: "conversation-origin-v1".into(),
        evidence: facts.evidence,
        complete,
    }
}

pub(crate) fn conversation_session_id_for_durable_session(id: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(id.as_bytes());
    let digest = format!("{:x}", hash.finalize());
    format!("cs_{}", &digest[..32])
}
