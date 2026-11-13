//! DS QueuedMessage (QueuedMessage.tsx / QueuedMessage.module.css): a user-side bubble that is not
//! sent yet. The bubble matches the MessageRow user bubble (width rule, radius, padding, type) so
//! a delivered message resolves in place; a dashed hairline sits inside its box. Long text clamps
//! to five lines behind a toggle, as a sent user message does.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, FontWeight, IntoElement, OverflowWrap, ParentElement,
    RenderOnce, SharedString, Styled as _, Window, div, point, px,
};

use super::message_row::{USER_BUBBLE_SHARE, bubble_cap, enter};
use crate::tokens::{Color, Duration as DsDuration, Easing, Length, Number};
use crate::ui::Icon;
use crate::ui::blocks::measure;
use crate::ui::button::{Button, Size, Variant};
use crate::ui::context::{Ds, Lang, keep_words};
use crate::ui::convert;
use crate::ui::icon::IconSize;
use crate::ui::icon::icon;
use crate::ui::icon_button::IconButton;
use crate::ui::motion::Props;
use crate::ui::strut;
use crate::ui::tooltip::Tooltip;
use crate::ui::typo::{Tone, Typo};

/// The lines a clamped bubble shows (the sent user message's clamp).
const CLAMP_LINES: usize = 5;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum QueuedTone {
    /// Waiting.
    #[default]
    Queued,
    /// Send now was requested: the controls are disabled.
    Sending,
    Failed,
}

type Handler = Rc<dyn Fn(&ClickEvent, &mut gpui::Window, &mut App)>;

#[derive(IntoElement)]
pub struct QueuedMessage {
    id: ElementId,
    text: SharedString,
    status: SharedString,
    tone: QueuedTone,
    edit: (SharedString, Option<Handler>),
    delete: (SharedString, Option<Handler>),
    toggle_labels: Option<(SharedString, SharedString)>,
    send_now: Option<(SharedString, Option<SharedString>, Option<Handler>)>,
    entering: bool,
}

impl QueuedMessage {
    /// `status` is the label above the bubble ("Queued · 2 of 3").
    pub fn new(
        id: impl Into<ElementId>,
        text: impl Into<SharedString>,
        status: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            text: text.into(),
            status: status.into(),
            tone: QueuedTone::Queued,
            edit: (SharedString::default(), None),
            delete: (SharedString::default(), None),
            toggle_labels: None,
            send_now: None,
            entering: false,
        }
    }

    pub fn tone(mut self, tone: QueuedTone) -> Self {
        self.tone = tone;
        self
    }

    pub fn on_edit(
        mut self,
        label: impl Into<SharedString>,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.edit = (label.into(), Some(Rc::new(handler)));
        self
    }

    pub fn on_delete(
        mut self,
        label: impl Into<SharedString>,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.delete = (label.into(), Some(Rc::new(handler)));
        self
    }

    /// Long text clamps to five lines behind this toggle.
    pub fn clamp(
        mut self,
        show_more: impl Into<SharedString>,
        show_less: impl Into<SharedString>,
    ) -> Self {
        self.toggle_labels = Some((show_more.into(), show_less.into()));
        self
    }

    /// Offered only for the message that would be sent next.
    pub fn send_now(
        mut self,
        label: impl Into<SharedString>,
        hint: Option<SharedString>,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.send_now = Some((label.into(), hint, Some(Rc::new(handler))));
        self
    }

    /// Just queued: fades in with a small rise.
    pub fn entering(mut self) -> Self {
        self.entering = true;
        self
    }
}

/// How many lines `text` takes wrapped to `width` in the body face.
fn lines(text: &str, width: f32, window: &mut Window, cx: &App) -> usize {
    measure::wrapped_lines(text, Length::FontSize3, width, window, cx)
}

impl QueuedMessage {
    /// The status label with its clock (or alert) icon.
    fn status_line(&self, failed: bool, ds: &Ds) -> gpui::Div {
        let (glyph, ink, tone) = if failed {
            (Icon::AlertCircle, Color::ColorDangerText, Tone::Danger)
        } else {
            (Icon::Clock3, Color::ColorTextSecondary, Tone::Secondary)
        };
        div()
            .flex()
            .items_center()
            .min_w_0()
            .gap(ds.len(Length::Space1))
            .text_color(ds.color(ink))
            .child(icon(glyph, IconSize::Sm, ds))
            .child(strut::flex_scope(
                false,
                Typo::caption(self.status.clone()).tone(tone),
            ))
    }

    /// The "Show more" / "Show less" button, offered once the text overflows.
    fn toggle(
        &self,
        overflowing: bool,
        open: bool,
        expanded: &gpui::Entity<bool>,
    ) -> Option<Button> {
        let (more, less) = self.toggle_labels.clone().filter(|_| overflowing)?;
        let on = expanded.clone();
        Some(
            Button::new((self.id.clone(), "toggle"))
                .variant(Variant::Inline)
                .text(if open { less } else { more })
                .on_click(move |_, _, cx| {
                    on.update(cx, |open, cx| {
                        *open = !*open;
                        cx.notify();
                    });
                }),
        )
    }

    /// The bubble's text; clamped, it clips at five lines (gpui's `line_clamp` counts hard breaks
    /// apart and draws no ellipsis).
    fn body_text(&self, clamped: bool, ds: &Ds) -> gpui::Div {
        let mut text = div().min_w_0();
        if ds.lang() == Lang::Ko {
            text = keep_words(text);
        }
        let text = text
            .overflow_wrap(OverflowWrap::Anywhere)
            .child(gpui::StyledText::new(self.text.clone()));
        if clamped {
            text.max_h(ds.len(Length::TypoBodyLineHeightDocument) * CLAMP_LINES as f32)
                .overflow_hidden()
        } else {
            text
        }
    }
}

impl RenderOnce for QueuedMessage {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let failed = self.tone == QueuedTone::Failed;
        let (seen, recorder) = measure::track((self.id.clone(), "bubble"), window, cx);
        let expanded = window.use_keyed_state((self.id.clone(), "expanded"), cx, |_, _| false);
        let open = *expanded.read(cx);
        let clamp = self.toggle_labels.is_some();
        let width = (f32::from(seen.width) - 20.).max(0.); // the bubble's padding, 10px a side
        let overflowing = clamp && width > 0. && lines(&self.text, width, window, cx) > CLAMP_LINES;
        let progress = self.entering.then(|| {
            enter::progress(
                (self.id.clone(), "enter"),
                (DsDuration::MotionBase, Easing::MotionEaseDecelerate),
                window,
                cx,
            )
        });
        let ds = Ds::get(cx);
        let status = self.status_line(failed, ds);
        let radius = ds.len(Length::RadiusPopover);
        let text = self.body_text(clamp && !open, ds);
        let toggle = self.toggle(overflowing, open, &expanded);
        let outline = ds.color(if failed {
            Color::DangerLineStrong
        } else {
            Color::LineStrong
        });
        let bubble = div()
            .relative()
            .min_w_0()
            .rounded(radius)
            .bg(convert::with_alpha(ds.color(Color::UserMessageBg), 0.4))
            .px(px(10.))
            .py(px(6.))
            .text_color(ds.color(Color::TextSecondary))
            .text_size(ds.len(Length::FontSize3))
            .line_height(ds.len(Length::TypoBodyLineHeightDocument))
            .font_weight(FontWeight(ds.number(Number::FontWeightRegular)))
            .child(recorder)
            .child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .rounded(radius)
                    .border(ds.len(Length::BorderHairline))
                    .border_dashed()
                    .border_color(outline),
            )
            .child(text)
            .children(toggle);
        let controls = self.controls(window, cx);
        let ds = Ds::get(cx);
        let row = div()
            .flex()
            .flex_col()
            .items_end()
            .gap(ds.len(Length::Space1))
            .pb(ds.len(Length::SpaceLg))
            .child(status)
            .child(bubble_cap(bubble, USER_BUBBLE_SHARE, false, true))
            .child(controls);
        match progress {
            Some((value, timing)) => value
                .apply(
                    row,
                    &timing,
                    &Props {
                        opacity: Some((0., 1.)),
                        offset: Some((
                            point(px(0.), ds.len(Length::MotionDistanceSm)),
                            point(px(0.), px(0.)),
                        )),
                        ..Default::default()
                    },
                )
                .into_any_element(),
            None => row.into_any_element(),
        }
    }
}

impl QueuedMessage {
    fn controls(&self, _: &mut Window, cx: &mut App) -> AnyElement {
        let ds = Ds::get(cx);
        let busy = self.tone == QueuedTone::Sending;
        let send_now = self.send_now.as_ref().map(|(label, hint, handler)| {
            let mut button = Button::new((self.id.clone(), "send-now"))
                .size(Size::Xs)
                .variant(Variant::Borderless)
                .text(label.clone());
            if busy {
                button = button.disabled();
            }
            if let Some(handler) = handler.clone() {
                button = button.on_click(move |event, window, cx| handler(event, window, cx));
            }
            match hint {
                Some(hint) => Tooltip::new((self.id.clone(), "send-now-hint"))
                    .label(hint.clone())
                    .child(button)
                    .into_any_element(),
                None => button.into_any_element(),
            }
        });
        let action = |key: &'static str,
                      (label, handler): &(SharedString, Option<Handler>),
                      glyph| {
            let mut button = IconButton::new((self.id.clone(), key), label.clone()).glyph(glyph);
            if busy {
                button = button.disabled();
            }
            if let Some(handler) = handler.clone() {
                button = button.on_click(move |event, window, cx| handler(event, window, cx));
            }
            button
        };
        div()
            .flex()
            .items_center()
            .gap(ds.len(Length::Space1))
            .children(send_now)
            .child(action("edit", &self.edit, Icon::PencilLine))
            .child(action("delete", &self.delete, Icon::Trash2))
            .into_any_element()
    }
}
