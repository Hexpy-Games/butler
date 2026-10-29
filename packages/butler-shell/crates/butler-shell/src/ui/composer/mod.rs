//! The floating composer (blocks/ComposerCard, ComposerControl, ComposerDecisionPanel).
mod approval;
mod toolbar;

use std::cell::Cell;
use std::rc::Rc;

use gpui::{
    AnimationExt as _, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    KeyBinding, SharedString, Window, actions, canvas, div, prelude::*, px,
};

use crate::ui::glass;
use crate::ui::input::{InputColors, TextInput};
use crate::ui::motion::Hover;
use crate::ui::source::{AuthorityCard, ComposerContext, Decision, RequestRef};
use crate::ui::theme::{Theme, alpha};
use crate::ui::widgets::HasHover;

actions!(composer, [Submit]);

pub(crate) fn bindings() -> Vec<KeyBinding> {
    vec![
        KeyBinding::new("enter", Submit, Some("TextInput")),
        KeyBinding::new("secondary-enter", Submit, Some("TextInput")),
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
    input: Entity<TextInput>,
    theme: Theme,
    engaged: bool,
    /// The open chat's turn is running (the send button stops it).
    pub(crate) streaming: bool,
    /// The open chat's first outstanding authority request (shown instead of the input), and
    /// whether an answer to it is on its way.
    pub(crate) approval: Option<(AuthorityCard, bool)>,
    /// Permission and model labels; `None` while no agent is attached.
    pub(crate) context: Option<ComposerContext>,
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

pub(crate) fn input_colors(t: &Theme) -> InputColors {
    InputColors {
        text: t.text,
        placeholder: t.placeholder,
        selection: alpha(t.accent, 0.28),
    }
}

impl Composer {
    pub(crate) fn new(theme: Theme, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let colors = input_colors(&theme);
        let placeholder = theme.strings.placeholder;
        let input = cx.new(|cx| TextInput::new(placeholder, colors, cx));
        let handle = input.read(cx).focus_handle.clone();
        let blur = cx.on_blur(&handle, window, |this: &mut Self, _, cx| {
            this.engaged = false;
            cx.notify();
        });
        Self {
            input,
            theme,
            engaged: false,
            streaming: false,
            approval: None,
            context: None,
            disabled: None,
            shell_focus: None,
            height: Rc::new(Cell::new(48.)),
            hover: Hover::default(),
            _blur: blur,
        }
    }

    pub(crate) fn set_theme(&mut self, theme: Theme, cx: &mut Context<Self>) {
        let colors = input_colors(&theme);
        self.input.update(cx, |i, _| i.set_colors(colors));
        self.theme = theme;
    }

    /// The placeholder for a new chat or a follow-up.
    pub(crate) fn set_new_chat(&mut self, new_chat: bool, cx: &mut Context<Self>) {
        let s = self.theme.strings;
        let p = if new_chat {
            s.placeholder
        } else {
            s.placeholder_follow_up
        };
        self.input.update(cx, |i, _| i.set_placeholder(p));
    }

    pub(crate) fn engage(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.disabled.is_some() {
            return;
        }
        self.engaged = true;
        let handle = self.input.read(cx).focus_handle.clone();
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

    fn submit(&mut self, _: &Submit, window: &mut Window, cx: &mut Context<Self>) {
        let input = self.input.read(cx);
        let text = input.text();
        let blocked = self.disabled.is_some() || self.streaming || input.is_composing();
        if blocked || text.trim().is_empty() {
            return;
        }
        self.input.update(cx, |i, cx| i.reset(window, cx));
        cx.emit(ComposerEvent::Send(text));
    }

    fn body(&mut self, cx: &mut Context<Self>) -> Vec<gpui::AnyElement> {
        if let Some((card, pending)) = self.approval.clone() {
            return vec![approval::panel(self, &card, pending, cx).into_any_element()];
        }
        let input = if self.engaged {
            div()
                .px(px(16.))
                .py(px(12.))
                .text_size(px(14.))
                .line_height(px(20.))
                .child(self.input.clone())
                .with_animation(
                    "body-in",
                    gpui::Animation::new(crate::ui::motion::FAST),
                    gpui::Styled::opacity,
                )
                .into_any_element()
        } else {
            // Keep the input mounted so its focus handle and IME state survive folding.
            div()
                .h(px(0.))
                .overflow_hidden()
                .child(self.input.clone())
                .into_any_element()
        };
        vec![input, self.toolbar(cx).into_any_element()]
    }
}

impl Focusable for Composer {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.input.read(cx).focus_handle.clone()
    }
}

impl Render for Composer {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = self.theme.clone();
        let height = self.height.clone();
        let probe = canvas(
            move |b, _, _| height.set(b.size.height.as_f32()),
            |_, (), _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();
        let card = glass::composer_surface(&t, 30.)
            .w_full()
            .flex()
            .flex_col()
            .on_action(cx.listener(Self::submit))
            .child(probe)
            .children(self.body(cx));
        div()
            .id("composer")
            .w_full()
            .child(card)
            .on_click(cx.listener(|this, _, window, cx| {
                if !this.engaged && this.approval.is_none() {
                    this.engage(window, cx);
                }
            }))
            // useComposerPresentation: a pointer-down anywhere else folds the composer.
            .on_mouse_down_out(cx.listener(|this, _, window, cx| {
                if this.engaged && !this.input.read(cx).is_composing() {
                    this.engaged = false;
                    if let Some(f) = &this.shell_focus {
                        window.focus(f, cx);
                    }
                    cx.notify();
                }
            }))
    }
}
