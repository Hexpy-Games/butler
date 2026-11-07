//! The floating composer (blocks/ComposerCard, ComposerControl, ComposerDecisionPanel).
mod adjunct;
mod approval;
mod attachments;
mod context;
pub(crate) mod editor;
mod menus;
mod notice;
mod queue;
mod state;
mod toolbar;

use std::cell::Cell;
use std::rc::Rc;

use butler_ds::ui::blocks::composer_card::{ComposerCard, ExpandedBody};
use gpui::{
    App, AppContext as _, Context, Entity, EntityInputHandler as _, EventEmitter, FocusHandle,
    Focusable, KeyBinding, SharedString, Window, actions, canvas, div, prelude::*, px,
};

use gpui_elements::editable_text::actions::DEFAULT_INPUT_CONTEXT;
use gpui_elements::editable_text::{EditableTextState, StringStorage};

use crate::ui::field;
use crate::ui::motion::Hover;
use crate::ui::source::wire::{ProgressRow, WorkerActivitySummary};
use crate::ui::source::{AuthorityCard, ComposerContext, Decision, RequestRef};
use crate::ui::theme::Theme;
use crate::ui::widgets::HasHover;

pub(crate) use toolbar::AgentNotice;

actions!(composer, [Submit]);

pub(crate) fn bindings() -> Vec<KeyBinding> {
    vec![
        KeyBinding::new("enter", Submit, Some(DEFAULT_INPUT_CONTEXT)),
        KeyBinding::new("secondary-enter", Submit, Some(DEFAULT_INPUT_CONTEXT)),
    ]
}

#[derive(Clone)]
pub(crate) enum ComposerEvent {
    Send(SharedString),
    Stop,
    Answer(RequestRef, Decision),
    /// The owner wants to suggest a change to this request.
    Modify(Box<AuthorityCard>),
}

pub(crate) struct Composer {
    input: Entity<EditableTextState>,
    /// The field's placeholder (new chat or follow-up).
    placeholder: &'static str,
    theme: Theme,
    engaged: bool,
    /// The open chat's turn is running (the send button stops it).
    pub(crate) streaming: bool,
    /// The open chat's first outstanding authority request (shown instead of the input), and
    /// whether an answer to it is on its way.
    pub(crate) approval: Option<(AuthorityCard, bool)>,
    /// Permission and model labels; `None` while no agent is attached.
    #[allow(dead_code, reason = "read by the menus wired at integration")]
    pub(crate) context: Option<ComposerContext>,
    /// The new-chat composer (`large`).
    new_chat: bool,
    /// `agentNotice` and `liveConnectionLost` of the store.
    pub(crate) agent_notice: Option<AgentNotice>,
    pub(crate) reconnecting: bool,
    /// Why the send button is blocked (`imageRefusalLabel` of a blocked attachment).
    pub(crate) send_blocked: Option<SharedString>,
    /// `state.workers`, `state.taskRows` and `state.taskTurnState` of the composer.
    pub(crate) workers: Vec<WorkerActivitySummary>,
    pub(crate) task_rows: Vec<ProgressRow>,
    pub(crate) task_turn_state: Option<String>,
    /// The open chat's summary says Git is not installed (`notice::git_missing`), and the owner
    /// closed the notice.
    pub(crate) git_missing: bool,
    git_notice_dismissed: bool,
    /// Why the composer cannot be used (shown as a tooltip), when it cannot.
    pub(crate) disabled: Option<SharedString>,
    /// Where focus goes when a click outside folds the composer.
    pub(crate) shell_focus: Option<FocusHandle>,
    /// The card's height as last drawn.
    height: Rc<Cell<f32>>,
    hover: Hover,
    _blur: gpui::Subscription,
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
        let blur = cx.on_blur(&handle, window, |this: &mut Self, _, cx| {
            this.engaged = false;
            cx.notify();
        });
        Self {
            input,
            placeholder,
            theme,
            engaged: false,
            streaming: false,
            approval: None,
            context: None,
            new_chat: true,
            agent_notice: None,
            reconnecting: false,
            send_blocked: None,
            workers: Vec::new(),
            task_rows: Vec::new(),
            task_turn_state: None,
            git_missing: false,
            git_notice_dismissed: false,
            disabled: None,
            shell_focus: None,
            height: Rc::new(Cell::new(48.)),
            hover: Hover::default(),
            _blur: blur,
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

    pub(crate) fn engage(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.disabled.is_some() {
            return;
        }
        self.engaged = true;
        let handle = self.input.read(cx).focus_handle(cx);
        window.focus(&handle, cx);
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
        self.input
            .update(cx, |i, cx| i.marked_text_range(window, cx).is_some())
    }

    pub(super) fn submit(&mut self, _: &Submit, window: &mut Window, cx: &mut Context<Self>) {
        let text = SharedString::from(self.input.read(cx).as_str().to_owned());
        let blocked = self.disabled.is_some() || self.streaming || self.composing(window, cx);
        if blocked || text.trim().is_empty() {
            return;
        }
        self.input.update(cx, |i, cx| {
            i.emplace("", cx);
            i.clear_history();
        });
        window.invalidate_character_coordinates();
        cx.emit(ComposerEvent::Send(text));
    }

    fn body(&mut self, cx: &mut Context<Self>) -> Vec<gpui::AnyElement> {
        if let Some((card, pending)) = self.approval.clone() {
            return vec![approval::panel(self, &card, pending, cx).into_any_element()];
        }
        let input = field::field("composer-input", &self.input, self.placeholder, &self.theme)
            .aria_label(self.theme.strings.message_composer);
        let input = crate::ui::widgets::anchor(input, "composer-field");
        // The editor stays mounted while folded so its focus handle and IME state survive.
        let editor = div()
            .px(px(16.))
            .py(px(12.))
            .text_size(px(14.))
            .line_height(px(20.))
            .capture_action(field::no_empty_cut(&self.input))
            .child(input);
        vec![
            ExpandedBody::new("composer-body")
                .child(editor)
                .into_any_element(),
            self.toolbar(cx).into_any_element(),
        ]
    }
}

impl Focusable for Composer {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.input.read(cx).focus_handle(cx)
    }
}

impl Render for Composer {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
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
            self.git_missing,
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
        let adjunct = adjunct::adjunct_panels(
            lang,
            &self.workers,
            &self.task_rows,
            self.task_turn_state.as_deref(),
        );
        let mut card =
            ComposerCard::new("composer-card").expanded(self.engaged || self.approval.is_some());
        if self.new_chat {
            card = card.large();
        }
        if let Some(notice) = notice {
            card = card.notice(notice);
        }
        if let Some(adjunct) = adjunct {
            card = card.adjunct(adjunct);
        }
        let card = card.children(self.body(cx));
        let column = butler_ds::ui::blocks::scope::conversation(cx).unwrap_or_default();
        let ds = butler_ds::ui::context::Ds::get(cx);
        crate::ui::widgets::anchor(div(), "composer")
            .absolute()
            .bottom(ds.len(butler_ds::tokens::Length::SpaceLg))
            .left(px(column.column_left))
            .w(px(column.column_width.max(0.)))
            .id("composer")
            .on_action(cx.listener(Self::submit))
            .child(probe)
            .child(card)
            .on_click(cx.listener(|this, _, window, cx| {
                if !this.engaged && this.approval.is_none() {
                    this.engage(window, cx);
                }
            }))
            // useComposerPresentation: a pointer-down anywhere else folds the composer.
            .on_mouse_down_out(cx.listener(|this, _, window, cx| {
                if this.engaged && !this.composing(window, cx) {
                    this.engaged = false;
                    if let Some(f) = &this.shell_focus {
                        window.focus(f, cx);
                    }
                    cx.notify();
                }
            }))
    }
}
