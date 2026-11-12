//! Coalesced navigation refreshes, guarded against stale live generations and reconnects.
use super::{Shell, Tab};
use crate::ui::source::{
    sidebar::{Mutation, ProjectCommand, SessionCommand, SpaceCommand},
    wire::{AppEventEnvelope, NavigationView, UpdateProgressView},
};
use gpui::Context;
use serde_json::{Value, json};
impl Shell {
    pub(crate) fn refresh_sidebar(&mut self, cx: &mut Context<Self>) {
        let Some(source) = self.source.clone() else {
            return;
        };
        let model = &mut self.store.navigation;
        self.theme.strings.space.clone_into(&mut model.space_label);
        self.theme
            .strings
            .general
            .clone_into(&mut model.general_label);
        if model.in_flight {
            model.dirty = true;
            return;
        }
        model.in_flight = true;
        model.dirty = false;
        let generation = model.generation;
        let epoch = self.store.epoch();
        Self::run(source.navigation(), cx, move |s, result, cx| {
            if epoch != s.store.epoch() {
                return;
            }
            s.store.navigation.in_flight = false;
            match result {
                Ok(view) if s.store.navigation.generation == generation => {
                    if let Some(notice) = view
                        .space
                        .smartNotice
                        .as_ref()
                        .filter(|n| n.revision == view.space.revision)
                    {
                        s.sidebar.undo_token = Some(notice.undoToken.clone());
                        s.sidebar.undo_revision = Some(notice.revision);
                    }
                    s.apply_sidebar_navigation(view);
                    s.push_navigation(cx);
                    s.store.navigation.retry_pending = false;
                }
                Ok(_) => {
                    s.store.navigation.dirty = true;
                }
                Err(_) => s.store.navigation.retry_pending = true,
            }
            if s.store.navigation.dirty {
                s.refresh_sidebar(cx);
            }
            if let Some(id) = s.store.selected().map(|c| c.session.0.to_string())
                && s.sidebar.attended
            {
                s.mark_sidebar_read(&id, cx);
            }
            s.ensure_canon(cx);
            s.organization_notice(cx);
            cx.notify();
        });
    }
    fn apply_sidebar_navigation(&mut self, view: NavigationView) {
        let reveal = self
            .store
            .selected()
            .map(|chat| chat.session.0.to_string())
            .filter(|id| self.store.navigation.active_parent_changed(&view, id));
        self.store.navigation.replace(view);
        if let Some(id) = reveal {
            self.reveal_sidebar(&id, false);
        }
    }
    /// Starts the loads the event asks for; true when it changed what the sidebar shows at once.
    pub(crate) fn sidebar_live_event(
        &mut self,
        event: &AppEventEnvelope,
        cx: &mut Context<Self>,
    ) -> bool {
        let mut stored = false;
        if event.r#type == "updates.progress"
            && let Some(progress) = event
                .payload
                .get("progress")
                .and_then(|value| serde_json::from_value::<UpdateProgressView>(value.clone()).ok())
        {
            stored = self.receive_sidebar_update(progress);
        }
        let navigation = reconciles_navigation(event);
        if navigation || self.store.navigation.retry_pending {
            self.refresh_sidebar(cx);
        }
        if event.r#type.starts_with("canon.") {
            self.refresh_canon(cx);
        }
        if self.sidebar.tab == Tab::Running {
            self.schedule_work_status(cx);
        }
        stored
    }
    pub(crate) fn refresh_sidebar_update(&mut self, cx: &mut Context<Self>) {
        if self.sidebar.update_in_flight {
            return;
        }
        let Some(source) = self.source.clone() else {
            return;
        };
        self.sidebar.update_in_flight = true;
        Self::run(source.sidebar_updates(), cx, move |s, result, cx| {
            if s.source
                .as_ref()
                .is_none_or(|current| !std::rc::Rc::ptr_eq(current, &source))
            {
                return;
            }
            s.sidebar.update_in_flight = false;
            if let Ok(status) = result
                && let Some(progress) = status.progress
            {
                s.receive_sidebar_update(progress);
                cx.notify();
            }
        });
    }
    fn receive_sidebar_update(&mut self, progress: UpdateProgressView) -> bool {
        let newer = self
            .sidebar
            .update
            .as_ref()
            .is_none_or(|previous| progress.revision >= previous.revision);
        if newer {
            self.sidebar.update = Some(progress);
        }
        newer
    }
    pub(super) fn mutate(&mut self, mutation: Mutation, cx: &mut Context<Self>) {
        if self.sidebar.pending {
            return;
        }
        let Some(source) = self.source.clone() else {
            return;
        };
        self.sidebar.pending = true;
        self.sidebar.error = None;
        self.store.navigation.generation += 1;
        self.sidebar.canon_generation += 1;
        let close_selected = self
            .store
            .selected()
            .filter(|chat| match &mutation {
                Mutation::Session(id, SessionCommand::Archive | SessionCommand::Delete) => {
                    id == chat.session.0.as_ref()
                }
                Mutation::Project(id, ProjectCommand::Archive | ProjectCommand::Delete) => self
                    .store
                    .navigation
                    .rows
                    .get(&format!("s:{}", chat.session.0))
                    .and_then(|r| r.session.as_ref())
                    .is_some_and(|session| session.project_id.as_ref() == Some(id)),
                _ => false,
            })
            .cloned();
        let command = mutation.clone();
        Self::run(
            source.sidebar_mutation(mutation),
            cx,
            move |s, result, cx| {
                if s.source
                    .as_ref()
                    .is_none_or(|current| !std::rc::Rc::ptr_eq(current, &source))
                {
                    return;
                }
                s.sidebar.pending = false;
                s.store.navigation.generation += 1;
                let succeeded = result.is_ok();
                match result {
                    Ok(result) => s.sidebar_mutated(&command, result, close_selected.as_ref(), cx),
                    Err(error) => {
                        s.sidebar.error = Some(s.theme.strings.load_failed.to_owned());
                        s.failed(&error, s.theme.strings.load_failed, cx);
                    }
                }
                if !succeeded || !matches!(command, Mutation::Space(SpaceCommand::Group, _)) {
                    s.refresh_sidebar(cx);
                }
                if matches!(
                    command,
                    Mutation::CanonOrder(_, _)
                        | Mutation::CanonEdit(_, _)
                        | Mutation::CanonPlanEdit(_, _)
                        | Mutation::CanonCreate(_, _)
                        | Mutation::CanonConversation(_)
                ) {
                    s.refresh_canon(cx);
                }
                cx.notify();
            },
        );
    }
    fn sidebar_mutated(
        &mut self,
        command: &Mutation,
        result: crate::ui::source::wire::SidebarMutationResult,
        close_selected: Option<&crate::ui::source::ChatRef>,
        cx: &mut Context<Self>,
    ) {
        if let Some(space) = result.space {
            self.sidebar.undo_token = result.undo_token;
            self.sidebar.undo_revision = Some(space.revision);
            if let Some(mut view) = self.store.navigation.view.clone() {
                view.space = space;
                self.apply_sidebar_navigation(view);
            }
        }
        if let Some(project) = result.project {
            self.open_sidebar_draft(
                Some(crate::ui::source::sidebar::DraftTarget::Project(project.id)),
                cx,
            );
        }
        if close_selected.is_some_and(|chat| self.store.selected() == Some(chat)) {
            self.open_sidebar_draft(None, cx);
        }
        if let Some(id) = result.session_id {
            self.show_sidebar_session(id, cx);
        }
        if matches!(command, Mutation::ClearGeneral(_)) {
            self.show_sidebar_session("general".to_owned(), cx);
        }
        if let Mutation::ResumeSubtask(_, parent) = command
            && self
                .store
                .selected()
                .is_some_and(|chat| chat.session.0.as_ref() == parent)
        {
            self.reload_open_chat(cx);
        }
        self.sidebar.set_dialog(None);
        if matches!(command, Mutation::CanonCreate(_, _))
            && let Some(id) = result.id
        {
            self.mutate(Mutation::CanonConversation(id), cx);
        }
    }
    pub(super) fn space_mutate(
        &mut self,
        command: SpaceCommand,
        mut body: Value,
        cx: &mut Context<Self>,
    ) {
        body["expectedRevision"] = json!(self.store.navigation.revision());
        self.mutate(Mutation::Space(command, body), cx);
    }
    pub(super) fn pin_sidebar_row(
        &mut self,
        row: &crate::ui::store::navigation::SpaceRowData,
        cx: &mut Context<Self>,
    ) {
        self.space_mutate(
            SpaceCommand::Pin,
            json!({"action":"pin", "nodeKey":row.node.key, "pinned":!row.pinned}),
            cx,
        );
    }
    pub(crate) fn mark_sidebar_read(&mut self, id: &str, cx: &mut Context<Self>) {
        if !self.sidebar.attended {
            return;
        }
        let row = self.store.navigation.rows.get(&format!("s:{id}"));
        if !row.and_then(|r| r.session.as_ref()).is_some_and(|s| {
            s.unread && crate::ui::store::navigation::space_activity(s, false) != Some("working")
        }) {
            return;
        }
        if self.sidebar.reading.contains(id) {
            return;
        }
        let Some(source) = self.source.clone() else {
            return;
        };
        self.sidebar.reading.insert(id.to_owned());
        let id = id.to_owned();
        Self::run(
            source.sidebar_mutation(Mutation::Session(id.clone(), SessionCommand::Read)),
            cx,
            move |s, result, cx| {
                if s.source
                    .as_ref()
                    .is_none_or(|current| !std::rc::Rc::ptr_eq(current, &source))
                {
                    return;
                }
                s.sidebar.reading.remove(&id);
                if result.is_ok() {
                    s.refresh_sidebar(cx);
                }
            },
        );
    }
}

/// `useLiveSessionEvents`: the events after which Electron reconciles navigation, so a row's
/// activity (working, attention) follows turns, questions, approvals and workers as they change.
fn reconciles_navigation(event: &AppEventEnvelope) -> bool {
    let kind = event.r#type.as_str();
    matches!(
        kind,
        "session.created"
            | "session.updated"
            | "session.permanently_deleted"
            | "turn.state_changed"
            | "subsession.changed"
            | "session_queue.changed"
            | "session.queue.changed"
    ) || [
        "space.",
        "project.",
        "question.",
        "authority.",
        "worker.",
        "worker_",
    ]
    .iter()
    .any(|prefix| kind.starts_with(prefix))
        || delivered_assistant(event)
}

/// `isDeliveredAssistantMessage`: an assistant message that is no longer pending, streaming or
/// retrying.
fn delivered_assistant(event: &AppEventEnvelope) -> bool {
    if !matches!(event.r#type.as_str(), "message.created" | "message.updated") {
        return false;
    }
    let message = event.payload.get("message");
    let field = |key: &str| message.and_then(|m| m.get(key)).and_then(Value::as_str);
    field("role") == Some("assistant")
        && !matches!(field("status"), Some("pending" | "streaming" | "retrying"))
}
