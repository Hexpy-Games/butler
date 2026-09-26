//! Public activity events; publication failure cannot veto a tool Turn.

use serde_json::{Map, json};

use crate::btcc::{AgentLoopProgress, GuidedSourceRevision, RuntimeTurnEventInput};

use super::State;

pub(super) fn publish(
    state: &mut State,
    id: &str,
    turn_id: &str,
    revisions: &GuidedSourceRevision,
) -> Vec<RuntimeTurnEventInput> {
    let mut events = Vec::new();
    let Some(group) = state.groups.get(id) else {
        return events;
    };
    let preceding = group.preceding.clone();
    let following = group.following.clone();
    for before in preceding {
        events.extend(publish(state, &before, turn_id, revisions));
    }
    let Some(group) = state.groups.get_mut(id) else {
        return events;
    };
    if group.published {
        return events;
    }
    group.published = true;
    let mut payload = Map::new();
    payload.insert("note".into(), json!(group.summary));
    payload.insert("btccState".into(), json!("admitted"));
    payload.insert("decisionTitle".into(), json!(group.title));
    payload.insert("decisionSummary".into(), json!(group.summary));
    payload.insert("decisionSource".into(), json!("model-authored"));
    payload.insert("semanticBlockId".into(), json!(group.id));
    payload.insert("originTurnId".into(), json!(turn_id));
    payload.insert("sourceRevision".into(), json!(revisions.next()));
    if let Some(stage) = group.stage {
        payload.insert("activityStage".into(), json!(stage));
    }
    if let Some(value) = &group.interface_content {
        payload.insert("interfaceContent".into(), value.clone());
    }
    if let Some(value) = &group.next_step {
        payload.insert("decisionNextStep".into(), json!(value));
    }
    let mut event = RuntimeTurnEventInput::new("assistant.public_note");
    event.payload = Some(payload);
    events.push(event);
    for after in following {
        events.extend(publish(state, &after, turn_id, revisions));
    }
    events
}

pub(super) async fn emit(progress: &dyn AgentLoopProgress, events: Vec<RuntimeTurnEventInput>) {
    for event in events {
        let _ = progress.emit(event).await;
    }
}
