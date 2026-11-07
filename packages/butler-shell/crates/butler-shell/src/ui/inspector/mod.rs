//! The conversation inspector (ConversationShell aside on InspectorPanel): the session sections,
//! the task graph and the artifacts.
mod artifacts;
mod order;
mod sections;
mod session_misc;
mod tasks;

use std::cell::Cell;
use std::rc::Rc;

use butler_ds::ui::blocks::conversation_shell::AsideLayout;
use gpui::{App, Context, IntoElement, Render, Window, div};

use crate::ui::source::wire::{AppEventEnvelope, SessionView};

pub(crate) use sections::{SessionSectionsModel, session_sections_model};
pub(crate) use session_misc::{SessionActionHandler, SessionInfoActionsProps, session_info_actions};
pub(crate) use tasks::{on_open_session_observer, tasks_panel_in_dialog};

/// What every inspector unit reads while one session renders.
#[derive(Clone)]
pub(crate) struct InspectorCtx<'a> {
    pub(crate) view: &'a SessionView,
    /// The same view as a shared handle, for state kept between frames.
    pub(crate) shared: Rc<SessionView>,
    /// Docked on the margin or floating on glass (the aside decides by width).
    pub(crate) layout: AsideLayout,
}

/// The session sections in the conversation aside (`Conversation.tsx` `aside`). The aside hands
/// its layout to a closure that has no window, so the pane reads it from a shared cell.
pub(crate) struct InspectorPane {
    view: Option<Rc<SessionView>>,
    /// The model the shell computed this frame: the one reader of the pending asks.
    model: Option<Rc<SessionSectionsModel>>,
    layout: Rc<Cell<AsideLayout>>,
}

impl InspectorPane {
    pub(crate) fn new() -> Self {
        Self {
            view: None,
            model: None,
            layout: Rc::new(Cell::new(AsideLayout::Docked)),
        }
    }

    pub(crate) fn set_view(&mut self, view: Option<Rc<SessionView>>) {
        self.view = view;
    }

    pub(crate) fn set_model(&mut self, model: Rc<SessionSectionsModel>) {
        self.model = Some(model);
    }

    /// Where the aside writes the layout it is drawing.
    pub(crate) fn layout_cell(&self) -> Rc<Cell<AsideLayout>> {
        self.layout.clone()
    }
}

impl Render for InspectorPane {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (Some(view), Some(model)) = (self.view.clone(), self.model.clone()) else {
            return div().into_any_element();
        };
        let ctx = InspectorCtx {
            view: &view,
            shared: view.clone(),
            layout: self.layout.get(),
        };
        sections::session_sections(&ctx, &model, window, cx)
    }
}

/// Live events the inspector's own readers follow (the canon queue and the task graphs).
pub(crate) fn live_event(event: &AppEventEnvelope, cx: &mut App) {
    order::queue::on_event(cx, &event.r#type, &event.payload);
    tasks::receive_task_graph_event(event, cx);
}
