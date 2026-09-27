use serde_json::json;

use super::*;
use crate::btcc::*;

pub(super) fn agent_result() -> AgentLoopResult {
    AgentLoopResult {
        route: ExecutionRoute::Direct,
        content: "done".into(),
        terminal_outcome: None,
        suspension: None,
        authority_continuation: None,
        work_status: None,
        accepted_work_result: None,
        runtime_failure: None,
        artifacts: vec![],
        changed_files: vec![],
        plan: None,
        model_identity: None,
    }
}

pub(super) fn record(turn_id: &str, session_id: &str, state: TurnSemanticState) -> TurnRecord {
    TurnRecord {
        turn_id: turn_id.into(),
        session_id: session_id.into(),
        inbox_id: "inbox".into(),
        trigger_key: "trigger".into(),
        original_message_id: "message".into(),
        original_message: "hello".into(),
        wake_identity: None,
        model_selection: json!({}),
        model_route: None,
        continuation_budget: None,
        context: json!({}),
        progress_destination: Some(ProgressDestination {
            transport: "app".into(),
            account_id: "account".into(),
            peer: Peer {
                kind: PeerKind::Dm,
                id: "peer".into(),
                parent_id: None,
            },
            reply_to_message_id: "message".into(),
            app_queue_claim_id: None,
        }),
        semantic_state: state,
        suspension: None,
        authority_continuation: None,
        checkpoint: None,
        route: None,
        final_payload: None,
        delivery_outbox: None,
        canonical_assistant_message_id: None,
        revision: 0,
        execution_fence: 0,
        final_disposition: None,
    }
}

pub(super) fn apply_final(turn: &mut TurnRecord) {
    let transition = super::transition::guided_final(turn, agent_result()).unwrap();
    if let TurnTransition::AcceptFinal {
        route,
        payload,
        outbox,
    } = transition
    {
        turn.route = Some(route);
        turn.final_payload = Some(*payload);
        turn.delivery_outbox = Some(*outbox);
        turn.semantic_state = TurnSemanticState::DeliveryCommitted;
        turn.revision += 1;
    }
}

pub(super) fn request(turn_id: &str, session_id: &str) -> TurnRequest {
    TurnRequest {
        turn_id: turn_id.into(),
        recovery_attempt: None,
        session_id: session_id.into(),
        event_id: "event".into(),
        transport: "app".into(),
        account_id: "account".into(),
        peer: Peer {
            kind: PeerKind::Dm,
            id: "peer".into(),
            parent_id: None,
        },
        sender: Sender {
            id: "sender".into(),
            display_name: None,
        },
        message: TurnMessage {
            id: "message".into(),
            content: "hello".into(),
            timestamp: "2026-09-14T00:00:00Z".into(),
            attachments: vec![],
            image_admission: None,
        },
        trigger: TurnTrigger::UserMessage,
        route: TurnRoute {
            role: SessionRole::Butler,
            workspace_path: "/tmp".into(),
            project_id: None,
            reason: None,
        },
        progress_destination: None,
        execution_controls: None,
        empty_response_policy: None,
        app_turn_context: None,
        authority_request_ref: None,
        authority_client_message_id: None,
        app_queue_claim_id: None,
        preparation_cancellation: tokio_util::sync::CancellationToken::new(),
    }
}
