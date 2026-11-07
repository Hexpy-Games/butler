//! The floating composer (blocks/ComposerCard, ComposerControl, ComposerDecisionPanel).
mod adjunct;
mod approval;
mod attachments;
mod context;
mod controls;
pub(crate) mod editor;
mod files;
mod inputs;
mod menus;
mod notice;
pub(crate) mod queue;
mod send;
mod slots;
mod state;
mod sync;
mod toolbar;
mod wire;

use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;

use butler_ds::ui::blocks::composer_card::{ComposerCard, ExpandedBody};
use butler_ds::ui::popover::Popover;
use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    KeyBinding, SharedString, Window, actions, canvas, div, prelude::*, px,
};

use gpui_elements::editable_text::actions::{self as text_actions, DEFAULT_INPUT_CONTEXT};
use gpui_elements::editable_text::{EditableTextState, StringStorage, TextChanged};

use self::attachments::{Attachments, composer_attachments, file_drag_active, file_drop};
use self::context::ComposerContextControl;
use self::controls::Controls;
use self::editor::clipboard::Paste;
use self::editor::{ComposerEditor, FocusPlacement};
use self::state::{ComposerState, image_refusal_label};
use crate::ui::field;
use crate::ui::motion::Hover;
use crate::ui::source::{AuthorityCard, Decision, RequestRef};
use crate::ui::theme::Theme;
use crate::ui::widgets::HasHover;

pub(crate) use inputs::Inputs;
pub(crate) use send::Outgoing;

actions!(composer, [Submit]);

pub(crate) fn bindings() -> Vec<KeyBinding> {
    vec![
        KeyBinding::new("enter", Submit, Some(DEFAULT_INPUT_CONTEXT)),
        KeyBinding::new("secondary-enter", Submit, Some(DEFAULT_INPUT_CONTEXT)),
    ]
}

#[derive(Clone)]
pub(crate) enum ComposerEvent {
    /// A draft to send into the open chat, or into a new one.
    Send(Box<Outgoing>),
    Stop,
    Answer(RequestRef, Decision),
    /// The owner wants to suggest a change to this request.
    Modify(Box<AuthorityCard>),
    /// The context popover's Details: open Settings > Usage.
    OpenUsageSettings,
}

/// The popovers of the toolbar; the composer stays expanded while one is open
/// (`protectedExpanded`).
const POPOVERS: [&str; 4] = [
    "composer-access-menu",
    "composer-model-menu",
    "composer-attachment-menu",
    "composer-documents-menu",
];

pub(crate) struct Composer {
    input: Entity<EditableTextState>,
    editor: ComposerEditor,
    controls: Controls,
    attachments: Attachments,
    context_control: Entity<ComposerContextControl>,
    /// What the shell last said about the open chat and the agent.
    inputs: Inputs,
    /// The draft revision the editor shows.
    synced_revision: u64,
    /// A toolbar popover is open.
    protected: bool,
    /// The field's placeholder (new chat or follow-up).
    placeholder: &'static str,
    theme: Theme,
    engaged: bool,
    /// The open chat's turn is running.
    pub(crate) streaming: bool,
    /// The open chat's first outstanding authority request (shown instead of the input), and
    /// whether an answer to it is on its way.
    pub(crate) approval: Option<(AuthorityCard, bool)>,
    /// The new-chat composer (`large`).
    new_chat: bool,
    git_notice_dismissed: bool,
    /// Why the composer cannot be used (shown as a tooltip), when it cannot.
    pub(crate) disabled: Option<SharedString>,
    /// Where focus goes when a click outside folds the composer.
    pub(crate) shell_focus: Option<FocusHandle>,
    /// The card's height as last drawn.
    height: Rc<Cell<f32>>,
    hover: Hover,
    _subscriptions: Vec<gpui::Subscription>,
}

impl EventEmitter<ComposerEvent> for Composer {}

impl HasHover for Composer {
    fn hover_state(&mut self) -> &mut Hover {
        &mut self.hover
    }
}

impl Composer {
    pub(crate) fn new(theme: Theme, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let placeholder = theme.strings.placeholder;
        let input = cx.new(|cx| EditableTextState::new(StringStorage::default(), cx));
        let handle = input.read(cx).focus_handle(cx);
        let mut editor = ComposerEditor::default();
        editor.bind(input.clone());
        let context_control = cx.new(|_| ComposerContextControl::new());
        let subscriptions = vec![
            cx.on_blur(&handle, window, |this: &mut Self, window, cx| {
                this.editor.save_selection(window, cx);
                this.engaged = false;
                cx.notify();
            }),
            cx.subscribe_in(&input, window, |this, _, _: &TextChanged, window, cx| {
                this.on_text_changed(window, cx);
            }),
            cx.subscribe(&context_control, |this, control, event, cx| {
                this.on_context_event(control, event, cx);
            }),
            cx.observe_window_activation(window, |this, window, cx| {
                if window.is_window_active() {
                    this.editor.on_window_activated(window, cx);
                }
            }),
        ];
        Self {
            input,
            editor,
            controls: Controls::default(),
            attachments: Attachments::default(),
            context_control,
            inputs: Inputs::default(),
            synced_revision: 0,
            protected: false,
            placeholder,
            theme,
            engaged: false,
            streaming: false,
            approval: None,
            new_chat: true,
            git_notice_dismissed: false,
            disabled: None,
            shell_focus: None,
            height: Rc::new(Cell::new(48.)),
            hover: Hover::default(),
            _subscriptions: subscriptions,
        }
    }

    pub(crate) fn set_theme(&mut self, theme: Theme, _cx: &mut Context<Self>) {
        self.theme = theme;
    }

    /// The placeholder for a new chat or a follow-up.
    pub(crate) fn set_new_chat(&mut self, new_chat: bool, _cx: &mut Context<Self>) {
        let s = self.theme.strings;
        self.new_chat = new_chat;
        self.placeholder = if new_chat {
            s.placeholder
        } else {
            s.placeholder_follow_up
        };
    }

    /// `focusComposer`: expands the card and puts the caret back where it was.
    pub(crate) fn engage(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.disabled.is_some() {
            return;
        }
        self.engaged = true;
        self.editor.focus(FocusPlacement::Restore, window, cx);
        cx.notify();
    }

    pub(crate) fn fold(&mut self) {
        self.engaged = false;
    }

    /// The card's measured height, shared with the conversation's composer reserve.
    pub(crate) fn height_cell(&self) -> Rc<Cell<f32>> {
        self.height.clone()
    }

    /// An IME composition is in progress in the field.
    fn composing(&self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        self.editor.composing(window, cx)
    }

    fn body(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Vec<AnyElement> {
        if let Some((card, pending)) = self.approval.clone() {
            return vec![approval::panel(self, &card, pending, cx).into_any_element()];
        }
        let lang = butler_ds::ui::context::Ds::get(cx).lang();
        let (attached, refused) = ComposerState::read(cx, |draft| {
            (draft.attachments.clone(), draft.blocked_attachments.clone())
        });
        let blocked: HashMap<String, SharedString> = refused
            .into_iter()
            .map(|(id, refusal)| (id, image_refusal_label(refusal, lang).into()))
            .collect();
        let (open, remove) = (cx.entity().downgrade(), cx.entity().downgrade());
        let tiles = composer_attachments(
            &attached,
            &self.attachments,
            &blocked,
            None,
            move |id, _, cx| {
                let id = id.to_string();
                let _ = open.update(cx, |this, cx| this.open_attached(&id, cx));
            },
            move |id, _, cx| {
                let id = id.to_string();
                let _ = remove.update(cx, |this, cx| this.remove_attachment(&id, cx));
            },
            cx,
        );
        let input = field::field("composer-input", &self.input, self.placeholder, &self.theme)
            .aria_label(self.theme.strings.message_composer);
        let input = crate::ui::widgets::anchor(input, "composer-field");
        // The editor stays mounted while folded so its focus handle and IME state survive.
        let editor = div()
            .px(px(16.))
            .py(px(12.))
            .text_size(px(14.))
            .line_height(px(20.))
            .capture_action(cx.listener(|this, _: &text_actions::Cut, window, cx| {
                if this.editor.copy(true, window, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|this, _: &text_actions::Copy, window, cx| {
                if this.editor.copy(false, window, cx) {
                    cx.stop_propagation();
                }
            }))
            .capture_action(cx.listener(|this, _: &text_actions::Paste, window, cx| {
                match this.editor.paste(&|_| true, window, cx) {
                    Paste::Inserted => cx.stop_propagation(),
                    Paste::Files(entries) => {
                        this.add_pasted(&entries, cx);
                        cx.stop_propagation();
                    }
                    Paste::Nothing => {}
                }
            }))
            .child(input);
        let mut body = ExpandedBody::new("composer-body").child(editor);
        if let Some(tiles) = tiles {
            body = body.child(tiles);
        }
        vec![
            body.into_any_element(),
            self.toolbar(window, cx).into_any_element(),
        ]
    }

    /// `useComposerPresentation`'s `protectedExpanded`.
    fn popover_open(window: &mut Window, cx: &mut Context<Self>) -> bool {
        let popover = POPOVERS
            .iter()
            .any(|id| Popover::new(*id, window, cx).is_open(cx));
        popover || ComposerState::read(cx, |draft| draft.context_popover_open)
    }
}

impl Focusable for Composer {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.input.read(cx).focus_handle(cx)
    }
}

impl Render for Composer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.pull_state(window, cx);
        self.take_focus_request(window, cx);
        self.protected = Self::popover_open(window, cx);
        let height = self.height.clone();
        let probe = canvas(
            move |b, _, _| height.set(b.size.height.as_f32()),
            |_, (), _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();
        let lang = butler_ds::ui::context::Ds::get(cx).lang();
        let this = cx.entity();
        let notice = notice::git_dependency_notice(
            self.inputs.git_missing,
            self.git_notice_dismissed,
            lang,
            move |_, cx| {
                this.update(cx, |this, cx| {
                    this.git_notice_dismissed = true;
                    cx.notify();
                });
            },
            cx,
        );
        let task_rows = self.inputs.task_rows();
        let adjunct = adjunct::adjunct_panels(
            lang,
            &self.inputs.workers,
            &task_rows,
            self.inputs
                .active_progress()
                .and_then(|p| p.state.as_deref()),
        );
        let expanded = self.engaged || self.approval.is_some() || self.protected;
        let mut card = ComposerCard::new("composer-card").expanded(expanded);
        if self.new_chat {
            card = card.large();
        }
        if file_drag_active(cx) {
            card = card.drop_active();
        }
        if let Some(notice) = notice {
            card = card.notice(notice);
        }
        if let Some(adjunct) = adjunct {
            card = card.adjunct(adjunct);
        }
        let card = card.children(self.body(window, cx));
        let column = butler_ds::ui::blocks::scope::conversation(cx).unwrap_or_default();
        let ds = butler_ds::ui::context::Ds::get(cx);
        let dropped = cx.entity().downgrade();
        let surface = crate::ui::widgets::anchor(div(), "composer")
            .absolute()
            .bottom(ds.len(butler_ds::tokens::Length::SpaceLg))
            .left(px(column.column_left))
            .w(px(column.column_width.max(0.)))
            .id("composer");
        file_drop(surface, move |files, _, cx| {
            let _ = dropped.update(cx, |this, cx| this.add_files(files, cx));
        })
        .on_action(cx.listener(Self::submit))
        .child(probe)
        .child(card)
        .on_click(cx.listener(|this, _, window, cx| {
            if !this.engaged && this.approval.is_none() {
                this.engage(window, cx);
            }
        }))
        // useComposerPresentation: a pointer-down anywhere else folds the composer, unless a
        // toolbar popover is open or the IME is composing.
        .on_mouse_down_out(cx.listener(|this, _, window, cx| {
            if this.engaged && !this.protected && !this.composing(window, cx) {
                this.engaged = false;
                if let Some(f) = &this.shell_focus {
                    window.focus(f, cx);
                }
                cx.notify();
            }
        }))
    }
}
