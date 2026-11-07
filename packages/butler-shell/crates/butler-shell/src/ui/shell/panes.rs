//! The panes around the conversation: the command palette (`AppShell`), the session sections in
//! the conversation aside and their titlebar actions (`Conversation.tsx`, `Titlebar.tsx`), the
//! task graph dialog (`SessionInfoActions`), and the file viewer beside the chat
//! (`ConversationBrowserFrame`).
use std::cell::Cell;
use std::rc::Rc;

use butler_ds::ui::blocks::adaptive_shell::split::AdaptiveShellSplit;
use butler_ds::ui::blocks::conversation_shell::AsideLayout;
use butler_ds::ui::context::Ds;
use butler_ds::ui::dialog::{Dialog, DialogContent, DialogHeader, DialogTitle, Layout, Size};
use butler_ds::ui::toast::{self, Toast};
use gpui::{AnyElement, AppContext as _, Context, Entity, IntoElement, Subscription, Window, prelude::*};

use super::navigation::Navigation;
use super::{Shell, TogglePalette};
use crate::ui::inspector::{
    InspectorCtx, InspectorPane, SessionActionHandler, SessionInfoActionsProps,
    session_info_actions, session_sections_model, tasks_panel_in_dialog,
};
use crate::ui::palette::{CommandPalette, PaletteEvent};
use crate::ui::source::wire::SessionView;
use crate::ui::viewer;

pub(super) struct Panes {
    palette: Entity<CommandPalette>,
    inspector: Entity<InspectorPane>,
    /// Where the aside writes the layout the inspector pane draws.
    layout: Rc<Cell<AsideLayout>>,
    /// The open chat's view as last shown.
    view: Option<Rc<SessionView>>,
    /// `sessionInfoOpen`.
    info_open: bool,
    /// `taskGraphEnabled`: a local UI preference (`appUiStateCache`) with no setter in the shell
    /// yet, so the task graph button stays hidden as in a fresh App.
    task_graph_enabled: bool,
    graph_open: bool,
    /// The conversation column's width while the viewer is beside it.
    chat_width: Option<f32>,
}

impl Shell {
    pub(super) fn new_panes(window: &mut Window, cx: &mut Context<Self>) -> (Panes, Subscription) {
        let palette = cx.new(|cx| CommandPalette::new(window, cx));
        let subscription = cx.subscribe_in(&palette, window, Self::on_palette);
        let inspector = cx.new(|_| InspectorPane::new());
        let layout = inspector.read(cx).layout_cell();
        let panes = Panes {
            palette,
            inspector,
            layout,
            view: None,
            info_open: false,
            task_graph_enabled: false,
            graph_open: false,
            chat_width: None,
        };
        (panes, subscription)
    }

    pub(super) fn toggle_palette(
        &mut self,
        _: &TogglePalette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.panes
            .palette
            .update(cx, |palette, cx| palette.toggle(window, cx));
    }

    fn on_palette(
        &mut self,
        _: &Entity<CommandPalette>,
        event: &PaletteEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            PaletteEvent::Dismissed => self.composer.update(cx, |c, cx| c.engage(window, cx)),
            PaletteEvent::OpenSession(id) => {
                self.navigate(Navigation::Session(id.clone()), window, cx);
            }
            // Project chats, schedules, settings, the log trace and space reveal land with the
            // screens that own them (P3); until then the palette says so.
            PaletteEvent::OpenProjectChat(_)
            | PaletteEvent::OpenSchedule(_)
            | PaletteEvent::OpenSettings(_)
            | PaletteEvent::RevealGroup(_)
            | PaletteEvent::OpenLogTrace => {
                toast::show(cx, Toast::message(self.theme.strings.not_yet));
            }
        }
    }

    /// The open view goes to the inspector pane too.
    pub(super) fn feed_panes(&mut self, view: Option<Rc<SessionView>>, cx: &mut Context<Self>) {
        self.panes.view.clone_from(&view);
        self.panes.inspector.update(cx, |pane, cx| {
            pane.set_view(view);
            cx.notify();
        });
    }

    /// `Conversation.tsx` `aside`: the session sections while session info is open.
    pub(super) fn aside(&self) -> Option<impl Fn(AsideLayout) -> AnyElement + 'static> {
        if !self.panes.info_open || self.panes.view.is_none() {
            return None;
        }
        let pane = self.panes.inspector.clone();
        let layout = self.panes.layout.clone();
        Some(move |next: AsideLayout| {
            layout.set(next);
            pane.clone().into_any_element()
        })
    }

    /// `Titlebar.tsx` `chatTrailing`: `SessionInfoActions` when the session has sections or the
    /// task graph is on.
    pub(super) fn session_actions(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let view = self.panes.view.clone()?;
        let ctx = InspectorCtx {
            view: &view,
            shared: view.clone(),
            layout: AsideLayout::Docked,
        };
        let model = session_sections_model(&ctx, window, cx);
        if !model.has_ids && !self.panes.task_graph_enabled {
            return None;
        }
        let toggle = cx.entity().downgrade();
        let graph = cx.entity().downgrade();
        let props = SessionInfoActionsProps {
            open: self.panes.info_open,
            on_toggle: Rc::new(move |_, cx| {
                let _ = toggle.update(cx, |s, cx| {
                    s.panes.info_open = !s.panes.info_open;
                    cx.notify();
                });
            }),
            on_open_task_graph: self.panes.task_graph_enabled.then(move || -> SessionActionHandler {
                Rc::new(move |_, cx| {
                    let _ = graph.update(cx, |s, cx| {
                        s.panes.graph_open = true;
                        cx.notify();
                    });
                })
            }),
            indicator: model.indicator,
            has_ids: model.has_ids,
        };
        Some(session_info_actions(&ctx, props, window, cx))
    }

    /// `Titlebar.tsx` `trailing`: the file viewer toggle of the open session.
    pub(super) fn viewer_toggle(&self, cx: &Context<Self>) -> Option<AnyElement> {
        let session = self.store.selected()?.session.0.clone();
        viewer::file_viewer_toggle(&session, None, cx)
    }

    /// `SessionInfoActions`' task graph dialog.
    pub(super) fn render_task_graph(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let weak = cx.entity().downgrade();
        let dialog = Dialog::new("task-graph", window, cx)
            .open(self.panes.graph_open)
            .on_open_change(move |open, _, cx| {
                let _ = weak.update(cx, |s, cx| {
                    s.panes.graph_open = open;
                    cx.notify();
                });
            });
        let body = self
            .panes
            .view
            .clone()
            .filter(|_| self.panes.graph_open)
            .map(|view| {
                let ctx = InspectorCtx {
                    view: &view,
                    shared: view.clone(),
                    layout: AsideLayout::Docked,
                };
                tasks_panel_in_dialog(&ctx, window, cx)
            });
        let title = crate::ui::i18n::task_graph::words(Ds::get(cx).lang()).title;
        let content = DialogContent::new()
            .size(Size::Full)
            .full_height()
            .layout(Layout::ScrollBody)
            .header(DialogHeader::new().child(DialogTitle::new(title)))
            .children(body);
        dialog.content(content, window, cx)
    }

    /// The conversation with the file viewer beside it while the viewer holds the right slot.
    pub(super) fn workspace(
        &mut self,
        conversation: AnyElement,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(session) = self.store.selected().map(|c| c.session.0.to_string()) else {
            return conversation;
        };
        let pane = viewer::file_viewer_pane(&session, window, cx);
        let width = cx.entity().downgrade();
        let mut split = AdaptiveShellSplit::new("conversation-split")
            .chat(conversation)
            .pane_open(pane.is_some())
            .on_chat_width_change(move |next, _, cx| {
                let _ = width.update(cx, |s, cx| {
                    s.panes.chat_width = Some(next);
                    cx.notify();
                });
            });
        if let Some(width) = self.panes.chat_width {
            split = split.chat_width(width);
        }
        if let Some(pane) = pane {
            split = split.pane(pane);
        }
        split.into_any_element()
    }

    pub(super) fn palette(&self) -> Entity<CommandPalette> {
        self.panes.palette.clone()
    }
}
