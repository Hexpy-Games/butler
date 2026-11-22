//! The panes around the conversation: the command palette (`AppShell`), the session sections in
//! the conversation aside and their titlebar actions (`Conversation.tsx`, `Titlebar.tsx`), the
//! task graph dialog (`SessionInfoActions`), and the file viewer or the image editor beside the
//! chat (`ConversationBrowserFrame`).
use std::cell::Cell;
use std::hash::{DefaultHasher, Hash as _, Hasher as _};
use std::rc::Rc;

use butler_ds::ui::blocks::adaptive_shell::SplitConfig;
use butler_ds::ui::blocks::adaptive_shell::frame::CHAT_WIDTH_DEFAULT;
use butler_ds::ui::blocks::adaptive_shell::split::AdaptiveShellSplit;
use butler_ds::ui::blocks::conversation_shell::AsideLayout;
use butler_ds::ui::context::Ds;
use butler_ds::ui::dialog::{Dialog, DialogContent, DialogHeader, DialogTitle, Layout, Size};
use gpui::{
    AnyElement, AppContext as _, Context, Entity, Focusable as _, IntoElement, Subscription,
    Window, prelude::*,
};

use super::manage_link::ComposerKey;
use super::navigation::Navigation;
use super::region;
use super::{Shell, TogglePalette};
use crate::ui::composer::focus_composer;
use crate::ui::images;
use crate::ui::inspector::{
    InspectorCtx, InspectorPane, SessionActionHandler, SessionInfoActionsProps,
    SessionSectionsState, session_info_actions, session_sections_model, tasks_panel_in_dialog,
};
use crate::ui::manage::View;
use crate::ui::palette::{CommandPalette, PaletteEvent};
use crate::ui::source::wire::{AppEventEnvelope, SessionView};
use crate::ui::viewer;

/// The pane the split was last given while open (`useHeldWhilePaneLeaves`): passed on while it
/// leaves, dropped when the split reports its exit.
#[derive(Clone)]
pub(super) enum Held {
    Browser,
    /// The files as last shown, so the leaving viewer keeps its file.
    Viewer(viewer::state::SessionFiles),
    /// The editor's view, kept alive past `close_editor` until the exit.
    Editor(gpui::AnyView),
}

pub(super) struct Panes {
    /// The pane the split was last given while open.
    pub(super) held: Option<Held>,
    palette: Entity<CommandPalette>,
    /// `useCommandPaletteFocus`'s `returnComposer`: the composer's key when its field had focus
    /// as the palette opened.
    return_composer: Option<ComposerKey>,
    inspector: Entity<InspectorPane>,
    /// The state the session sections read besides the view (the titlebar and the inspector).
    sections: Entity<SessionSectionsState>,
    /// Where the aside writes the layout the inspector pane draws.
    layout: Rc<Cell<AsideLayout>>,
    /// The open chat's view as last shown.
    pub(super) view: Option<Rc<SessionView>>,
    /// `sessionInfoOpen`.
    info_open: bool,
    /// `taskGraphEnabled`: a local UI preference (`appUiStateCache`) with no setter in the shell
    /// yet, so the task graph button stays hidden as in a fresh App.
    task_graph_enabled: bool,
    graph_open: bool,
    /// The conversation column's width while the viewer is beside it.
    chat_width: Option<f32>,
    /// `splitChatWidth` (`AppShell.tsx`): the conversation's width while the viewer holds the
    /// right slot, as of the last workspace; `None` without the viewer.
    split: Option<f32>,
}

impl Shell {
    pub(super) fn new_panes(window: &mut Window, cx: &mut Context<Self>) -> (Panes, Subscription) {
        let palette = cx.new(|cx| CommandPalette::new(window, cx));
        let subscription = cx.subscribe_in(&palette, window, Self::on_palette);
        let sections = cx.new(SessionSectionsState::new);
        cx.observe(&sections, |_, _, cx| cx.notify()).detach();
        let inspector = cx.new(|_| InspectorPane::new(sections.clone()));
        let layout = inspector.read(cx).layout_cell();
        let panes = Panes {
            held: None,
            palette,
            return_composer: None,
            inspector,
            sections,
            layout,
            view: None,
            info_open: false,
            task_graph_enabled: false,
            graph_open: false,
            chat_width: None,
            split: None,
        };
        (panes, subscription)
    }

    pub(crate) fn toggle_palette(
        &mut self,
        _: &TogglePalette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.panes.palette.read(cx).is_open() {
            let focused = self.composer.read(cx).focus_handle(cx).is_focused(window);
            self.panes.return_composer = focused.then(|| self.composer_key(cx));
        }
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
            PaletteEvent::Dismissed => {
                let back = self.panes.return_composer.take();
                match self.settings_view.clone() {
                    Some(view) => view.update(cx, |view, cx| view.focus(window, cx)),
                    // Back to the composer, at the draft end, only when it had focus and its
                    // editor is still the same one (`editor.isConnected`).
                    None if back.is_some_and(|key| key == self.composer_key(cx)) => {
                        focus_composer(cx);
                        self.composer.update(cx, |_, cx| cx.notify());
                    }
                    None => {}
                }
            }
            // A chat replaces the settings screen (`view` leaves `settings`).
            PaletteEvent::OpenSession(id) => {
                self.close_settings(cx);
                self.navigate(Navigation::Session(id.clone()), window, cx);
            }
            PaletteEvent::OpenProjectChat(project) => {
                self.close_settings(cx);
                let target = crate::ui::source::sidebar::DraftTarget::Project(project.clone());
                self.open_sidebar_draft(Some(target), cx);
            }
            PaletteEvent::RevealGroup(group) => {
                self.reveal_node(&format!("g:{group}"), true);
                cx.notify();
            }
            PaletteEvent::OpenSettings(section) => self.open_settings(section, window, cx),
            // `openLatestLogTrace`: the latest turn's trace is not wired yet; the log list opens.
            PaletteEvent::OpenLogTrace => self.open_settings("logs", window, cx),
            // `navigateCommandResult` `automation:<id>`: the schedule's detail replaces Settings.
            PaletteEvent::OpenSchedule(id) => {
                self.close_settings(cx);
                self.set_view(View::AutomationDetail(id.clone().into()), window, cx);
            }
        }
    }

    /// A live event goes to the session sections state (it reads the pending asks on some).
    pub(super) fn feed_sections_event(&mut self, event: &AppEventEnvelope, cx: &mut Context<Self>) {
        self.panes
            .sections
            .update(cx, |sections, cx| sections.live_event(event, cx));
        if let Some(settings) = &self.settings_view {
            settings.update(cx, |settings, cx| settings.live_event(event, cx));
        }
    }

    /// The open view goes to the inspector pane too.
    pub(super) fn feed_panes(&mut self, view: Option<Rc<SessionView>>, cx: &mut Context<Self>) {
        self.panes.view.clone_from(&view);
        self.panes
            .sections
            .update(cx, |sections, cx| sections.show(view.as_deref(), cx));
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
            crate::ui::widgets::anchor(gpui::div().id("inspector").size_full(), "inspector")
                .child(pane.clone())
                .into_any_element()
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
            layout: AsideLayout::Docked,
        };
        let model = session_sections_model(&ctx, &self.panes.sections, cx);
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
            on_open_task_graph: self.panes.task_graph_enabled.then(
                move || -> SessionActionHandler {
                    Rc::new(move |_, cx| {
                        let _ = graph.update(cx, |s, cx| {
                            s.panes.graph_open = true;
                            cx.notify();
                        });
                    })
                },
            ),
            indicator: model.indicator,
            has_ids: model.has_ids,
        };
        Some(session_info_actions(&ctx, props, window, cx))
    }

    /// `Titlebar.tsx` `trailing`: the file viewer toggle of the open session.
    pub(super) fn viewer_toggle(&self, cx: &Context<Self>) -> Option<AnyElement> {
        let session = self.store.selected()?.session.0.clone();
        viewer::file_viewer_toggle(
            &session,
            crate::ui::browser::shell_state::browser_raise(&session, cx),
            cx,
        )
    }

    /// `AppShell.tsx` `splitChatWidth={pane ? chatWidth : undefined}`: the width the split gives
    /// the conversation column while the viewer is beside it (400 until dragged).
    pub(super) fn split_chat_width(&self) -> Option<f32> {
        self.panes.split
    }

    /// The shell's split: open with the pane, at the chat width, keyed by the conversation so another
    /// conversation places the pane at once (`splitOpen`, `contextKey`).
    pub(super) fn split_config(&self) -> Option<SplitConfig> {
        let mut key = DefaultHasher::new();
        self.store.selected()?.session.0.hash(&mut key);
        let open = self.panes.split;
        let width = open.or(self.panes.chat_width);
        Some(
            SplitConfig::new(open.is_some())
                .chat_width(width.unwrap_or(CHAT_WIDTH_DEFAULT))
                .context_key(key.finish()),
        )
    }

    /// A management view has no split beside it.
    pub(super) fn clear_split(&mut self) {
        self.panes.split = None;
        self.panes.held = None;
    }

    /// `SessionInfoActions`' task graph dialog.
    pub(super) fn render_task_graph(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if !self.panes.graph_open {
            return None;
        }
        let weak = cx.entity().downgrade();
        let dialog = Dialog::new("task-graph", window, cx)
            .open(self.panes.graph_open)
            .on_open_change(move |open, _, cx| {
                let _ = weak.update(cx, |s, cx| {
                    s.panes.graph_open = open;
                    cx.notify();
                });
            });
        let body = self.panes.view.clone().map(|view| {
            let ctx = InspectorCtx {
                view: &view,
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
        Some(dialog.content(content, window, cx))
    }

    /// The conversation with the file viewer beside it while the viewer holds the right slot, or
    /// the image editor while it edits an image of this conversation (`splitOpen={paneOpen ||
    /// editingImage}`); an editor of another conversation closes.
    pub(super) fn workspace(
        &mut self,
        conversation: AnyElement,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(session) = self.store.selected().map(|c| c.session.0.to_string()) else {
            self.panes.split = None;
            self.panes.held = None;
            return conversation;
        };
        let editing = match images::editor_target(cx) {
            Some(target) if target.session.as_ref() == session => true,
            Some(_) => {
                images::close_editor(cx);
                false
            }
            None => false,
        };
        let files = viewer::session_files(cx, &session);
        let pane = viewer::right_slot_pane(
            crate::ui::browser::shell_state::browser_raise(&session, cx),
            &files,
        );
        let pane_open = editing || pane.is_some();
        self.panes.split = pane_open.then(|| {
            self.panes
                .chat_width
                .unwrap_or(butler_ds::ui::blocks::adaptive_shell::frame::CHAT_WIDTH_DEFAULT)
        });
        let width = cx.entity().downgrade();
        let mut split = AdaptiveShellSplit::new("conversation-split")
            .chat(conversation)
            .pane_open(pane_open)
            .on_chat_width_change(move |next, _, cx| {
                let _ = width.update(cx, |s, cx| {
                    s.panes.chat_width = Some(next);
                    cx.notify();
                });
            });
        if let Some(width) = self.panes.chat_width {
            split = split.chat_width(width);
        }
        split = split.frame_view(self.regions.titlebar.entity_id());
        let editor = editing.then(|| images::editor_view(window, cx)).flatten();
        let shown = match (editor, pane) {
            (Some(view), _) => Some(Held::Editor(view)),
            (None, Some(viewer::RightSlotPane::Browser)) => Some(Held::Browser),
            (None, Some(viewer::RightSlotPane::Viewer)) => Some(Held::Viewer(files)),
            (None, None) => None,
        };
        if shown.is_some() {
            self.panes.held = shown;
        }
        if let Some(held) = self.panes.held.clone() {
            split = split.pane(self.held_pane(held));
        }
        let exit = cx.entity().downgrade();
        split
            .on_pane_exit(move |_, cx| {
                let _ = exit.update(cx, |s, cx| {
                    if s.panes.held.take().is_some() {
                        cx.notify();
                    }
                });
            })
            .into_any_element()
    }

    fn held_pane(&self, held: Held) -> AnyElement {
        match held {
            Held::Editor(view) => view.into_any_element(),
            Held::Browser => self
                .regions
                .browser
                .clone()
                .cached(region::fill())
                .into_any_element(),
            Held::Viewer(_) => self
                .regions
                .viewer
                .clone()
                .cached(region::fill())
                .into_any_element(),
        }
    }

    /// The viewer pane of the open conversation (empty while there is none; `workspace` only
    /// embeds it while the pane is open).
    pub(super) fn render_viewer_pane(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let session = self.store.selected().map(|c| c.session.0.to_string());
        let Some(Held::Viewer(files)) = &self.panes.held else {
            return gpui::div().into_any_element();
        };
        session
            .and_then(|session| viewer::file_viewer_pane_of(&session, files, window, cx))
            .unwrap_or_else(|| gpui::div().into_any_element())
    }

    pub(crate) fn palette(&self) -> Entity<CommandPalette> {
        self.panes.palette.clone()
    }
}
