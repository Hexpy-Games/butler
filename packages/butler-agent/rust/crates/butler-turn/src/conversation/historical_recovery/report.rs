use serde_json::{Value, json};

use super::classifier::{Decision, Provenance, Role};
use super::identity::redacted;
use super::import::Outcome;

pub(super) fn report(decisions: &[Decision], outcomes: &[Outcome], dry_run: bool) -> Value {
    let mappings = outcomes
        .iter()
        .filter_map(|outcome| outcome.mapping.as_ref())
        .map(|mapping| {
            json!({
                "source_kind": mapping.kind.text(),
                "source_id": redacted(mapping.kind.text(), &mapping.source_id),
                "conversation_session_id": redacted("conversation_session", &mapping.session_id),
                "conversation_message_id": redacted("conversation_message", &mapping.message_id),
                "status": mapping.status,
            })
        })
        .collect::<Vec<_>>();
    let rows = decisions.iter().map(|decision| {
        let source_ref = format!("{}:{}", decision.kind.text(), decision.source_id);
        json!({
            "source_kind": decision.kind.text(),
            "source_id": redacted(decision.kind.text(), &format!("{}:{}", decision.session_id, decision.source_id)),
            "session_id": redacted("session", &decision.session_id),
            "conversation_session_id": decision.conversation_session_id.as_deref().map(|id| redacted("conversation_session", id)),
            "conversation_turn_id": decision.conversation_turn_id.as_deref().map(|id| redacted("conversation_turn", id)),
            "conversation_message_id": decision.conversation_message_id.as_deref().map(|id| redacted("conversation_message", id)),
            "provenance": decision.provenance.text(), "admit": decision.admit,
            "reason": decision.reason, "role": decision.role.map(Role::text),
            "created_at": decision.created_at,
            "audit_refs": [redacted("audit", &source_ref)],
        })
    }).collect::<Vec<_>>();
    json!({
        "ok": true,
        "dry_run": dry_run,
        "counts": {
            "total": decisions.len(),
            "trusted": decisions.iter().filter(|d| matches!(d.provenance, Provenance::Trusted)).count(),
            "recovered": decisions.iter().filter(|d| matches!(d.provenance, Provenance::Recovered)).count(),
            "discarded": decisions.iter().filter(|d| matches!(d.provenance, Provenance::Discarded)).count(),
            "ambiguous": decisions.iter().filter(|d| matches!(d.provenance, Provenance::Ambiguous)).count(),
            "admissible": decisions.iter().filter(|d| d.admit).count(),
            "imported": outcomes.iter().filter(|o| o.imported).count(),
            "skipped_existing": outcomes.iter().filter(|o| o.skipped_existing).count(),
        },
        "rows": rows,
        "mappings": mappings,
        "privacy": { "rawTextIncluded": false, "secretsIncluded": false },
    })
}
