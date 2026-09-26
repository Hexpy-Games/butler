//! One Turn's presentation correlation. It never authorizes or mutates Work.

mod content;
mod publication;
mod snapshot;

use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::{Map, Value};

use crate::btcc::{
    AgentLoopProgress, BtccError, GuidedActivitySnapshot, GuidedSourceRevision, ModelRoundToolCall,
    WorkStage, WorkView,
};

use content::{Content, activity_kind, content, resumed};
use publication::{emit, publish};

#[derive(Clone)]
struct Group {
    id: String,
    stage: Option<WorkStage>,
    deferred: bool,
    title: String,
    summary: String,
    rationale: Option<String>,
    next_step: Option<String>,
    interface_content: Option<Value>,
    preceding: Vec<String>,
    following: Vec<String>,
    starts_execution: bool,
    resumes_work: bool,
    next_execution_title: Option<String>,
    published: bool,
    extensions: Map<String, Value>,
}

#[derive(Clone)]
pub(crate) struct ActivityBinding {
    id: String,
    stage: Option<WorkStage>,
    deferred: bool,
}

struct Pending {
    name: String,
    group_id: String,
    claimed: bool,
}

#[derive(Default)]
struct State {
    groups: IndexMap<String, Group>,
    pending: Vec<Pending>,
    bindings: IndexMap<String, ActivityBinding>,
    managed: bool,
    current: Option<String>,
    fallback: Option<String>,
    pending_stage: Option<WorkStage>,
    pending_title: Option<String>,
}

pub(crate) struct NativeGuidedActivity {
    turn_id: String,
    source_revision: GuidedSourceRevision,
    state: Mutex<State>,
}

impl NativeGuidedActivity {
    pub(crate) fn new(
        turn_id: String,
        source_revision: GuidedSourceRevision,
        initial_work: Option<&WorkView>,
    ) -> Self {
        let mut state = State::default();
        if let Some(work) = initial_work {
            state.managed = true;
            state.pending_stage = work.current_stage;
            state.pending_title = Some(resumed(work).title);
        }
        Self {
            turn_id,
            source_revision,
            state: Mutex::new(state),
        }
    }

    pub(crate) fn restore(&self, snapshot: &GuidedActivitySnapshot) -> Result<(), BtccError> {
        let state = snapshot::restore(snapshot)?;
        *self.state.lock() = state;
        Ok(())
    }

    pub(crate) fn snapshot(&self) -> GuidedActivitySnapshot {
        snapshot::capture(&self.state.lock())
    }

    pub(crate) fn source_revision(&self) -> u64 {
        self.source_revision.current()
    }

    pub(crate) fn observe_batch(
        &self,
        turn_id: &str,
        text: &str,
        calls: &[ModelRoundToolCall],
    ) -> Result<(), BtccError> {
        self.check_turn(turn_id)?;
        let mut state = self.state.lock();
        state.pending.clear();
        let mut ordinary_group: Option<String> = None;
        let ordinary_calls = calls
            .iter()
            .filter(|call| activity_kind(&call.name) == "ordinary")
            .collect::<Vec<_>>();
        for call in calls {
            let kind = activity_kind(&call.name);
            if kind != "ordinary" {
                ordinary_group = None;
            }
            let group_id = if kind == "ordinary" {
                if let Some(id) = &ordinary_group {
                    id.clone()
                } else {
                    let id = new_group(&mut state, turn_id, call, &ordinary_calls, text);
                    ordinary_group = Some(id.clone());
                    id
                }
            } else {
                new_group(&mut state, turn_id, call, &[call], text)
            };
            state.pending.push(Pending {
                name: call.name.clone(),
                group_id,
                claimed: false,
            });
        }
        Ok(())
    }

    pub(crate) async fn observe_tool(
        &self,
        turn_id: &str,
        call: &ModelRoundToolCall,
        journal_call_id: &str,
        progress: &dyn AgentLoopProgress,
    ) -> Result<ActivityBinding, BtccError> {
        self.check_turn(turn_id)?;
        let (binding, events) = {
            let mut state = self.state.lock();
            if let Some(existing) = state.bindings.get(journal_call_id) {
                return Ok(existing.clone());
            }
            let index = state
                .pending
                .iter()
                .position(|pending| !pending.claimed && pending.name == call.name)
                .or_else(|| state.pending.iter().position(|pending| !pending.claimed));
            let batch_managed = state
                .pending
                .iter()
                .any(|pending| activity_kind(&pending.name) != "ordinary");
            let mut group_id = if let Some(index) = index {
                state.pending[index].claimed = true;
                state.pending[index].group_id.clone()
            } else {
                new_group(&mut state, turn_id, call, &[call], "")
            };
            let kind = activity_kind(&call.name);
            if kind == "ordinary" {
                if let Some(stage) = state.pending_stage.take() {
                    let title = state.pending_title.take();
                    if let Some(group) = state.groups.get_mut(&group_id) {
                        group.stage = Some(stage);
                        if let Some(title) = title {
                            group.title = title;
                        }
                    }
                    state.current = Some(group_id.clone());
                    state.fallback = None;
                }
                group_id = state
                    .current
                    .clone()
                    .unwrap_or_else(|| state.fallback.get_or_insert(group_id.clone()).clone());
            } else {
                state.managed = true;
            }
            let group = state.groups.get(&group_id).expect("activity group exists");
            let binding = ActivityBinding {
                id: group_id.clone(),
                stage: group.stage,
                deferred: group.deferred,
            };
            let events = if (state.managed || batch_managed) && !binding.deferred {
                publish(&mut state, &group_id, &self.turn_id, &self.source_revision)
            } else {
                Vec::new()
            };
            state
                .bindings
                .insert(journal_call_id.to_owned(), binding.clone());
            (binding, events)
        };
        emit(progress, events).await;
        Ok(binding)
    }

    pub(crate) async fn publish_accepted(
        &self,
        turn_id: &str,
        journal_call_id: &str,
        work: Option<&WorkView>,
        progress: &dyn AgentLoopProgress,
    ) -> Result<(), BtccError> {
        self.check_turn(turn_id)?;
        let events = {
            let mut state = self.state.lock();
            state.managed = true;
            let Some(binding) = state.bindings.get(journal_call_id).cloned() else {
                return Ok(());
            };
            let Some(group) = state.groups.get_mut(&binding.id) else {
                return Ok(());
            };
            if group.resumes_work
                && let Some(work) = work
            {
                let update = resumed(work);
                group.title = update.title;
                group.summary = update.summary;
                group.stage = update.stage;
                group.interface_content = update.interface_content;
            }
            let starts_execution = group.starts_execution;
            let next_title = group.next_execution_title.clone();
            let following = group.following.last().cloned();
            if starts_execution {
                state.pending_stage = Some(WorkStage::Execution);
                state.pending_title = next_title;
                state.current = None;
            } else {
                state.pending_stage = None;
                state.pending_title = None;
                state.current = following.or(Some(binding.id.clone()));
            }
            state.fallback = None;
            publish(
                &mut state,
                &binding.id,
                &self.turn_id,
                &self.source_revision,
            )
        };
        emit(progress, events).await;
        Ok(())
    }

    fn check_turn(&self, turn_id: &str) -> Result<(), BtccError> {
        if self.turn_id == turn_id {
            Ok(())
        } else {
            Err(BtccError::new(
                "guided_activity_turn_mismatch",
                "Activity owner belongs to a different Turn",
            ))
        }
    }
}

fn new_group(
    state: &mut State,
    turn_id: &str,
    first: &ModelRoundToolCall,
    calls: &[&ModelRoundToolCall],
    text: &str,
) -> String {
    let Content {
        title,
        summary,
        stage,
        next_step,
        interface_content,
        next_execution_title,
    } = content(first, calls, text);
    let id = format!("guided-activity:{turn_id}:{}", uuid::Uuid::new_v4());
    let kind = activity_kind(&first.name);
    let deferred = first.name == "continue_work" || !matches!(kind, "ordinary" | "work_selection");
    let mut group = Group {
        id: id.clone(),
        stage,
        deferred,
        title,
        summary,
        rationale: None,
        next_step,
        interface_content,
        preceding: Vec::new(),
        following: Vec::new(),
        starts_execution: false,
        resumes_work: first.name == "continue_work",
        next_execution_title: None,
        published: false,
        extensions: Map::new(),
    };
    if first.name == "record_work_review"
        && first.arguments.get("subject").and_then(Value::as_str) == Some("plan")
        && first.arguments.get("verdict").and_then(Value::as_str) == Some("accept")
    {
        group.starts_execution = true;
        group.next_execution_title = next_execution_title;
    }
    if first.name == "replace_work_plan" {
        let before = format!("guided-activity:{turn_id}:{}", uuid::Uuid::new_v4());
        let conception = content::conception(&group.summary);
        state.groups.insert(
            before.clone(),
            Group {
                id: before.clone(),
                stage: Some(WorkStage::Conception),
                deferred,
                title: conception.title,
                summary: conception.summary,
                rationale: None,
                next_step: conception.next_step,
                interface_content: conception.interface_content,
                preceding: Vec::new(),
                following: Vec::new(),
                starts_execution: false,
                resumes_work: false,
                next_execution_title: None,
                published: false,
                extensions: Map::new(),
            },
        );
        group.preceding.push(before);
    }
    if first.name == "record_work_review"
        && first.arguments.get("subject").and_then(Value::as_str) == Some("completion")
        && first.arguments.get("verdict").and_then(Value::as_str) == Some("accept")
        && let Some(report) = content::reporting(text)
    {
        let after = format!("guided-activity:{turn_id}:{}", uuid::Uuid::new_v4());
        state.groups.insert(
            after.clone(),
            Group {
                id: after.clone(),
                stage: Some(WorkStage::Reporting),
                deferred,
                title: report.title,
                summary: report.summary,
                rationale: None,
                next_step: None,
                interface_content: report.interface_content,
                preceding: Vec::new(),
                following: Vec::new(),
                starts_execution: false,
                resumes_work: false,
                next_execution_title: None,
                published: false,
                extensions: Map::new(),
            },
        );
        group.following.push(after);
    }
    state.groups.insert(id.clone(), group);
    id
}
