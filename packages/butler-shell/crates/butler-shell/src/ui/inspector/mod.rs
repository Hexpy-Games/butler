//! The conversation inspector (ConversationShell aside on InspectorPanel): the session sections,
//! the task graph and the artifacts.
mod artifacts;
mod order;
pub(crate) use order::install_epic_host;
pub(crate) mod sections;
mod session_misc;
mod tasks;

use std::cell::Cell;
use std::rc::Rc;

use butler_ds::ui::blocks::conversation_shell::AsideLayout;
use gpui::{App, Context, Entity, IntoElement, Render, Window, div};

use crate::ui::source::wire::{AppEventEnvelope, SessionView};

pub(crate) use sections::{SessionSectionsState, session_sections_model, view_facts};
pub(crate) use session_misc::{
    SessionActionHandler, SessionInfoActionsProps, session_info_actions,
};
pub(crate) use tasks::{on_open_session_observer, tasks_panel_in_dialog};

/// What every inspector unit reads while one session renders.
#[derive(Clone)]
pub(crate) struct InspectorCtx<'a> {
    pub(crate) view: &'a SessionView,
    /// Docked on the margin or floating on glass (the aside decides by width).
    pub(crate) layout: AsideLayout,
}

/// The session sections in the conversation aside (`Conversation.tsx` `aside`). The aside hands
/// its layout to a closure that has no window, so the pane reads it from a shared cell.
pub(crate) struct InspectorPane {
    view: Option<Rc<SessionView>>,
    sections: Entity<SessionSectionsState>,
    layout: Rc<Cell<AsideLayout>>,
}

impl InspectorPane {
    pub(crate) fn new(sections: Entity<SessionSectionsState>) -> Self {
        Self {
            view: None,
            sections,
            layout: Rc::new(Cell::new(AsideLayout::Docked)),
        }
    }

    pub(crate) fn set_view(&mut self, view: Option<Rc<SessionView>>) {
        self.view = view;
    }

    /// Where the aside writes the layout it is drawing.
    pub(crate) fn layout_cell(&self) -> Rc<Cell<AsideLayout>> {
        self.layout.clone()
    }
}

impl Render for InspectorPane {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(view) = self.view.clone() else {
            return div().into_any_element();
        };
        let ctx = InspectorCtx {
            view: &view,
            layout: self.layout.get(),
        };
        let model = session_sections_model(&ctx, &self.sections, cx);
        sections::session_sections(&ctx, &model, window, cx)
    }
}

/// Live events the inspector's own readers follow (the canon queue and the task graphs).
pub(crate) fn live_event(event: &AppEventEnvelope, cx: &mut App) {
    order::queue::on_event(cx, &event.r#type, &event.payload);
    tasks::receive_task_graph_event(event, cx);
}
