//! DS MessageRow (MessageRow.tsx / MessageRow.module.css): the presenter of a chat row. It owns
//! the assistant and user layouts, the body width, the pending state, the footer slot and the
//! entrance of a row that just arrived. Rows whose body is the user bubble are right-aligned;
//! assistant bodies are one column of sections a `--space-lg` apart.
pub(crate) mod enter;
mod parts;

use gpui::{
    AnyElement, App, ElementId, FontWeight, InteractiveElement as _, IntoElement, OverflowWrap,
    ParentElement, RenderOnce, Styled as _, Window, div, px, relative,
};

pub use parts::{
    MessageBubble, MessageBubbleAttachments, MessageFooter, MessageStatusLabel, MessageStatusRow,
    MessageTurnGroup, footer_actions,
};

use crate::tokens::{Color, Duration as DsDuration, Easing, Length, Number};
use crate::ui::context::{Ds, Lang, keep_words};
use crate::ui::motion::Props;

/// The widest bubbles get: user `min(440px, 68%)`, Butler `min(440px, 90%)` of the row
/// (`--message-bubble-max-width`).
const BUBBLE_MAX: f32 = 440.;
pub(crate) const USER_BUBBLE_SHARE: f32 = 0.68;
const BUTLER_BUBBLE_SHARE: f32 = 0.90;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Assistant,
    User,
    System,
    SystemEvent,
    ToolSummary,
    Automation,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Tone {
    Pending,
    Failed,
    #[default]
    Complete,
}

/// A row that just arrived: it fades in with a small rise; `Delivered` resolves a queued bubble
/// in place.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Entering {
    #[default]
    No,
    Yes,
    Delivered,
}

/// `child` capped at `min(440px, share)` of its container (user 68%, Butler 90%): `wide` makes
/// it that wide, else it shrinks to its content up to the cap; `end` puts it against the end
/// edge when the cap leaves room. (CSS takes the minimum of a length and a percentage; gpui has
/// one maximum per box, so two nested boxes cap by the share and by the length.)
pub(crate) fn bubble_cap(child: impl IntoElement, share: f32, wide: bool, end: bool) -> AnyElement {
    let mut outer = div().flex().min_w_0().max_w(relative(share));
    let mut inner = div().min_w_0().max_w(px(BUBBLE_MAX));
    if wide {
        outer = outer.w(relative(share));
        inner = inner.w_full();
    }
    if end {
        outer = outer.justify_end();
    }
    outer.child(inner.child(child)).into_any_element()
}

#[expect(
    clippy::struct_excessive_bools,
    reason = "independent flags, as the React props"
)]
#[derive(IntoElement)]
pub struct MessageRow {
    id: ElementId,
    role: Role,
    avatar: Option<AnyElement>,
    footer: Option<AnyElement>,
    tone: Tone,
    compaction_event: bool,
    activity: bool,
    bubble: bool,
    entering: Entering,
    grouped: bool,
    children: Vec<AnyElement>,
}

impl MessageRow {
    pub fn new(id: impl Into<ElementId>, role: Role) -> Self {
        Self {
            id: id.into(),
            role,
            avatar: None,
            footer: None,
            tone: Tone::Complete,
            compaction_event: false,
            activity: false,
            bubble: false,
            entering: Entering::No,
            grouped: false,
            children: Vec::new(),
        }
    }

    pub fn avatar(mut self, avatar: impl IntoElement) -> Self {
        self.avatar = Some(avatar.into_any_element());
        self
    }

    /// Metadata outside the bubble: a user message's sent time and copy action.
    pub fn footer(mut self, footer: MessageFooter) -> Self {
        self.footer = Some(footer.flush().end().into_any_element());
        self
    }

    pub fn tone(mut self, tone: Tone) -> Self {
        self.tone = tone;
        self
    }

    pub fn compaction_event(mut self) -> Self {
        self.compaction_event = true;
        self
    }

    /// Active turn activity.
    pub fn activity(mut self) -> Self {
        self.activity = true;
        self
    }

    /// Assistant only: the left-aligned 대화 row with its answer in a `MessageBubble`.
    pub fn bubble(mut self) -> Self {
        self.bubble = true;
        self
    }

    pub fn entering(mut self, entering: Entering) -> Self {
        self.entering = entering;
        self
    }

    /// Inside a `MessageTurnGroup`: its gap replaces the row's bottom padding.
    pub(super) fn grouped(mut self) -> Self {
        self.grouped = true;
        self
    }
}

impl ParentElement for MessageRow {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl MessageRow {
    fn single_column(&self) -> bool {
        matches!(self.role, Role::Assistant | Role::User) || self.compaction_event
    }

    /// The row's bottom padding.
    fn padding_bottom(&self) -> f32 {
        if self.grouped {
            return 0.;
        }
        if self.compaction_event {
            return 28.;
        }
        if self.activity {
            return 18.;
        }
        match self.role {
            Role::Assistant => 26.,
            _ => 18.,
        }
    }

    /// The body: text size and line height of a document, the role's layout.
    fn body(&mut self, window: &mut Window, cx: &mut App) -> AnyElement {
        let ds = Ds::get(cx);
        let children = std::mem::take(&mut self.children);
        let base = div()
            .min_w_0()
            .text_size(ds.len(Length::FontSize3))
            .line_height(ds.len(Length::TypoBodyLineHeightDocument))
            .overflow_wrap(OverflowWrap::Normal);
        let pending = if self.tone == Tone::Pending { 0.72 } else { 1. };
        match self.role {
            Role::User => {
                let bubble = self.user_bubble(children, window, cx);
                bubble_cap(bubble, USER_BUBBLE_SHARE, false, true)
            }
            Role::Assistant => {
                let top = if self.activity || self.grouped {
                    0.
                } else {
                    2.
                };
                let bottom = if self.grouped {
                    0.
                } else {
                    f32::from(ds.len(Length::SpaceXs))
                };
                let column = base
                    .flex()
                    .flex_col()
                    .gap(ds.len(Length::SpaceLg))
                    .pt(px(top))
                    .pb(px(bottom))
                    .text_color(ds.color(Color::TextPrimary))
                    .opacity(pending)
                    .children(children);
                if self.bubble {
                    column.items_start().into_any_element()
                } else {
                    column.into_any_element()
                }
            }
            _ => base
                .pt(px(if self.activity { 0. } else { 2. }))
                .opacity(pending)
                .children(children)
                .into_any_element(),
        }
    }

    /// The user bubble: shape, fill and padding, with the delivered resolve of a queued bubble.
    fn user_bubble(
        &self,
        children: Vec<AnyElement>,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let delivered = (self.entering == Entering::Delivered).then(|| {
            enter::progress(
                (self.id.clone(), "delivered"),
                (DsDuration::MotionSlow, Easing::MotionEaseDecelerate),
                window,
                cx,
            )
        });
        let ds = Ds::get(cx);
        let fill = ds.color(Color::UserMessageBg);
        let shown = delivered.map_or(1., |(value, timing)| value.value(&timing));
        if delivered.is_some_and(|(value, timing)| value.moving(&timing)) {
            // The foreground is arbitrary children; it re-renders for the fade's duration only.
            crate::ui::motion::input_frame(window);
        }
        let ink = crate::ui::convert::mix(
            ds.color(Color::TextPrimary),
            ds.color(Color::TextSecondary),
            shown,
        );
        let radius = ds.len(Length::RadiusPopover);
        let korean = ds.lang() == Lang::Ko;
        let mut bubble = div().relative().min_w_0();
        if korean {
            bubble = keep_words(bubble);
        }
        let mut bubble = bubble
            .rounded(radius)
            .overflow_wrap(OverflowWrap::Anywhere)
            .py(px(6.))
            .px(px(10.)) // DS: MessageRow.module.css:63
            .text_size(ds.len(Length::FontSize3))
            .line_height(ds.len(Length::TypoBodyLineHeightDocument))
            .font_weight(FontWeight(ds.number(Number::FontWeightRegular)))
            .text_color(ink)
            .opacity(if self.tone == Tone::Pending { 0.72 } else { 1. });
        let background = div().absolute().size_full().rounded(radius).bg(fill);
        let background = match delivered {
            Some((value, timing)) => value.apply(
                background,
                &timing,
                &Props {
                    opacity: Some((0.4, 1.)),
                    ..Default::default()
                },
            ),
            None => background,
        };
        bubble = bubble.child(background);
        if let Some((value, timing)) = delivered {
            let pending = div()
                .absolute()
                .size_full()
                .rounded(radius)
                .border(ds.len(Length::BorderHairline))
                .border_dashed()
                .border_color(ds.color(Color::LineStrong));
            bubble = bubble.child(value.apply(
                pending,
                &timing,
                &Props {
                    opacity: Some((1., 0.)),
                    ..Default::default()
                },
            ));
        }
        bubble
            .child(div().relative().children(children))
            .into_any_element()
    }
}

impl RenderOnce for MessageRow {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let bottom = self.padding_bottom();
        let (gap, row_gap) = {
            let md = ds.len(Length::SpaceMd);
            match (self.activity, self.role) {
                (true, _) => (px(0.), px(0.)),
                (_, Role::User) => (md, ds.len(Length::Space1)),
                _ => (md, md),
            }
        };
        let compaction = ds.len(Length::SpaceXl);
        let entering = self.entering;
        let progress = (entering == Entering::Yes).then(|| {
            enter::progress(
                (self.id.clone(), "enter"),
                (DsDuration::MotionBase, Easing::MotionEaseDecelerate),
                window,
                cx,
            )
        });
        let rise = f32::from(Ds::get(cx).len(Length::MotionDistanceSm));
        let single = self.single_column();
        let body = self.body(window, cx);
        let lead = if single {
            body
        } else {
            let avatar = self.avatar.take().map(|avatar| {
                div()
                    .flex_none()
                    .w(px(28.)) // DS: MessageRow.module.css:6
                    .mt(px(if self.activity { 0. } else { 2. }))
                    .child(avatar)
            });
            div()
                .flex()
                .items_start()
                .gap(gap)
                .children(avatar)
                .child(div().flex_1().min_w_0().child(body))
                .into_any_element()
        };
        let mut row = div()
            .id(self.id.clone())
            .flex()
            .flex_col()
            .min_w_0()
            .gap(row_gap)
            .pb(px(bottom));
        if self.role == Role::User {
            row = row.items_end();
        }
        if self.compaction_event {
            row = row.pt(compaction);
        }
        row = row.child(lead);
        if let Some(footer) = self.footer.take() {
            row = row.child(div().min_w_0().w_full().child(footer));
        }
        match progress {
            Some((value, timing)) => value
                .apply(
                    div().relative().child(row),
                    &timing,
                    &Props {
                        opacity: Some((0., 1.)),
                        offset: Some((gpui::point(px(0.), px(rise)), gpui::point(px(0.), px(0.)))),
                        ..Default::default()
                    },
                )
                .into_any_element(),
            None => row.into_any_element(),
        }
    }
}
