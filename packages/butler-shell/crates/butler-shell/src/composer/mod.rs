//! The floating composer (blocks/ComposerCard, ComposerControl, ComposerDecisionPanel).
mod approval;
mod toolbar;

use gpui::{
    AnimationExt as _, App, Context, Entity, EventEmitter, FocusHandle, Focusable, KeyBinding,
    SharedString, Window, actions, div, prelude::*, px,
};

use crate::glass;
use crate::input::{InputColors, TextInput};
use crate::motion::Hover;
use crate::source::{AuthorityCard, ComposerContext, Decision};
use crate::theme::{Theme, alpha};
use crate::widgets::HasHover;

actions!(composer, [Submit]);

pub(crate) fn bindings() -> Vec<KeyBinding> {
    vec![
        KeyBinding::new("enter", Submit, Some("TextInput")),
        KeyBinding::new("secondary-enter", Submit, Some("TextInput")),
    ]
}

pub(crate) enum ComposerEvent {
    Send(SharedString),
    Stop,
    Answer(SharedString, Decision),
}

/// Placeholders: a new chat, and a follow-up in an open chat.
const ASK: &str = "버틀러에게 무엇이든 물어보세요";
const FOLLOW_UP: &str = "후속 변경사항 요청";

pub(crate) struct Composer {
    input: Entity<TextInput>,
    theme: Theme,
    engaged: bool,
    /// The open chat's turn is running (the send button stops it).
    pub(crate) streaming: bool,
    /// The open chat's first outstanding authority request (shown instead of the input).
    pub(crate) approval: Option<AuthorityCard>,
    /// Permission and model labels; `None` while no agent is attached.
    pub(crate) context: Option<ComposerContext>,
    /// Why the composer cannot be used (shown as a tooltip), when it cannot.
    pub(crate) disabled: Option<SharedString>,
    /// Where focus goes when a click outside folds the composer.
    pub(crate) shell_focus: Option<FocusHandle>,
    hover: Hover,
    _blur: gpui::Subscription,
}

impl EventEmitter<ComposerEvent> for Composer {}

impl HasHover for Composer {
    fn hover_state(&mut self) -> &mut Hover {
        &mut self.hover
    }
}

fn input_colors(t: &Theme) -> InputColors {
    InputColors {
        text: t.text,
        placeholder: t.placeholder,
        selection: alpha(t.accent, 0.28),
    }
}

impl Composer {
    pub(crate) fn new(theme: Theme, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let colors = input_colors(&theme);
        let input = cx.new(|cx| TextInput::new(ASK, colors, cx));
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
        let p = if new_chat { ASK } else { FOLLOW_UP };
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

    /// Card height for the conversation's composer reserve (folded / expanded / decision).
    pub(crate) fn height(&self, cx: &App) -> f32 {
        if let Some(card) = &self.approval {
            return 2. + 54. + 20. + 16. * card.details.len() as f32 + 45.;
        }
        if !self.engaged {
            return 48.;
        }
        let input = self.input.read(cx);
        let lines = input
            .layout
            .as_ref()
            .map_or(1, crate::input::Layout::line_count);
        2. + 24. + 20. * lines.clamp(1, 8) as f32 + 47.
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
        let mut card = glass::composer_surface(&t, 30.)
            .w_full()
            .flex()
            .flex_col()
            .on_action(cx.listener(Self::submit));
        if let Some(request) = self.approval.clone() {
            card = card.child(approval::panel(self, &request, cx));
        } else {
            if self.engaged {
                card = card.child(
                    div()
                        .px(px(16.))
                        .py(px(12.))
                        .text_size(px(14.))
                        .line_height(px(20.))
                        .child(self.input.clone())
                        .with_animation(
                            "body-in",
                            gpui::Animation::new(crate::motion::FAST),
                            gpui::Styled::opacity,
                        ),
                );
            } else {
                // Keep the input mounted so its focus handle and IME state survive folding.
                card = card.child(div().h(px(0.)).overflow_hidden().child(self.input.clone()));
            }
            card = card.child(self.toolbar(cx));
        }
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
