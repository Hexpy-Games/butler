//! Delegation identities and the reviewed-plan checks shared by steward and
//! worker delegation.

use super::error;
use crate::btcc::{BtccCode, BtccError};

/// Digest namespaces and id prefixes of one delegation kind. The derived ids
/// are persisted, so these strings are part of the storage format.
pub(super) struct DelegationNaming {
    delegation: &'static str,
    relation: &'static str,
    session: &'static str,
    session_prefix: &'static str,
    turn: &'static str,
    turn_prefix: &'static str,
}

pub(super) const STEWARD: DelegationNaming = DelegationNaming {
    delegation: "btcc.subsession.delegation.v1",
    relation: "btcc.subsession.relation.v1",
    session: "btcc.subsession.child-session.v1",
    session_prefix: "steward",
    turn: "btcc.subsession.child-turn.v1",
    turn_prefix: "steward-turn",
};

pub(super) const WORKER: DelegationNaming = DelegationNaming {
    delegation: "btcc.worker.delegation.v1",
    relation: "btcc.worker.relation.v1",
    session: "btcc.worker.session.v1",
    session_prefix: "worker",
    turn: "btcc.worker.turn.v1",
    turn_prefix: "worker-turn",
};

/// The idempotent delegation id of a request identity.
pub(super) fn delegation_id(
    naming: &DelegationNaming,
    identity: &impl serde::Serialize,
) -> Result<String, BtccError> {
    let encoded = serde_json::to_string(identity)
        .map_err(|source| error(BtccCode::SubsessionIdentityInvalid).with_source(source))?;
    Ok(format!(
        "delegation-{}",
        crate::btcc::digest_identity(&format!("{}\0{encoded}", naming.delegation))
    ))
}

/// A digest shortened to `len` characters.
fn short_digest(input: &str, len: usize) -> String {
    let digest = crate::btcc::digest_identity(input);
    digest
        .get(..len)
        .map_or_else(|| digest.clone(), str::to_owned)
}

/// The ids derived from a delegation id.
pub(super) struct DelegationIds {
    pub(super) delegation_id: String,
    pub(super) relation_id: String,
    pub(super) child_session_id: String,
    pub(super) child_turn_id: String,
}

impl DelegationIds {
    pub(super) fn derive(naming: &DelegationNaming, delegation_id: String) -> Self {
        let relation_id = format!(
            "relation-{}",
            short_digest(&format!("{}\0{delegation_id}", naming.relation), 40)
        );
        let child_session_id = format!(
            "{}-{}",
            naming.session_prefix,
            short_digest(&format!("{}\0{relation_id}", naming.session), 32)
        );
        let child_turn_id = format!(
            "{}-{}",
            naming.turn_prefix,
            short_digest(&format!("{}\0{relation_id}", naming.turn), 32)
        );
        Self {
            delegation_id,
            relation_id,
            child_session_id,
            child_turn_id,
        }
    }
}
