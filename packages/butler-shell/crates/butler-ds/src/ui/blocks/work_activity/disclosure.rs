//! WorkActivityDisclosure (WorkActivityDisclosure.tsx / WorkActivityDisclosure.module.css): a
//! work timeline folded to its tail. Collapsed, the status line and the tail (the previous
//! activity fading upward, the latest on the timeline dot and line, and a "+N" count) are one
//! disclosure button. Expanded, the tail folds away so only the full timeline remains, and a
//! collapse chevron marks the status line as the way back.
use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement, RenderOnce, SharedString, Styled as _,
    Window, div, linear_color_stop, linear_gradient, px,
};

use super::marker;
use crate::tokens::{Color, Duration as DsDuration, Easing, Length};
use crate::ui::Icon;
use crate::ui::blocks::anim;
use crate::ui::clickable::{Clickable, Variant};
use crate::ui::collapsible::Collapsible;
use crate::ui::context::Ds;
use crate::ui::convert;
use crate::ui::icon::icon_px;
use crate::ui::motion::Timing;
use crate::ui::rolling_swap::RollingSwap;
use crate::ui::strut;
use crate::ui::tag::Tag;
use crate::ui::typo::{Tone, Typo};

/// The tail's geometry: the line's x and the content column. // DS: WorkActivityDisclosure.module.css:5
const LINE_X: f32 = 9.;
const CONTENT_X: f32 = 28.;
/// The collapse chevron's box: `1lh` of a caption line. // DS: WorkActivityDisclosure.module.css:50
const CAPTION_LINE: f32 = 16.;
/// The previous row's top fade is a mask from 20% to 75% opacity: its mean. // DS:
/// WorkActivityDisclosure.module.css:122
const PREVIOUS_OPACITY: f32 = 0.475;

type Toggle = Rc<dyn Fn(&mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct WorkActivityDisclosure {
    id: ElementId,
    status: SharedString,
    latest: SharedString,
    previous: Option<SharedString>,
    hidden: usize,
    live: bool,
    expanded: bool,
    on_toggle: Option<Toggle>,
    children: Vec<AnyElement>,
}

impl WorkActivityDisclosure {
    /// `status` is the run state line ("Working", "Done"), `latest` the newest activity.
    pub fn new(
        id: impl Into<ElementId>,
        status: impl Into<SharedString>,
        latest: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            status: status.into(),
            latest: latest.into(),
            previous: None,
            hidden: 0,
            live: false,
            expanded: false,
            on_toggle: None,
            children: Vec::new(),
        }
    }

    /// The activity before the latest: one line fading toward the top.
    pub fn previous(mut self, previous: impl Into<SharedString>) -> Self {
        self.previous = Some(previous.into());
        self
    }

    /// Records inside beyond the latest one; the "+N" tag.
    pub fn hidden_count(mut self, count: usize) -> Self {
        self.hidden = count;
        self
    }

    /// The work is still running: the latest dot pulses.
    pub fn live(mut self) -> Self {
        self.live = true;
        self
    }

    pub fn expanded(mut self, expanded: bool) -> Self {
        self.expanded = expanded;
        self
    }

    pub fn on_toggle(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_toggle = Some(Rc::new(handler));
        self
    }
}

impl ParentElement for WorkActivityDisclosure {
    /// The full timeline, bounded by the caller.
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// One tail row: a dot on the line and a one-line caption; the latest carries the count.
fn row(
    id: (ElementId, &'static str),
    text: SharedString,
    latest: Option<(bool, usize)>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let live = latest.is_some_and(|(live, _)| live);
    let dot = marker::dot(
        (ElementId::from((id.0.clone(), id.1)), "dot"),
        live,
        window,
        cx,
    );
    let ds = Ds::get(cx);
    let mut row = div()
        .relative()
        .flex()
        .items_center()
        .w_full()
        .min_w_0()
        .gap(ds.len(Length::SpaceSm))
        .pl(px(CONTENT_X))
        .child(
            div()
                .absolute()
                .top_0()
                .bottom_0()
                .left(px(LINE_X - 3.))
                .flex()
                .items_center()
                .child(dot),
        )
        .child(div().flex_1().min_w_0().child(strut::flex_scope(
            false,
            Typo::caption(text).tone(Tone::Secondary).truncate(),
        )));
    match latest {
        Some((_, hidden)) => {
            row = row
                .min_h(ds.len(Length::TagHeightSm))
                .child(count(id.0, hidden, ds));
        }
        None => row = row.opacity(PREVIOUS_OPACITY),
    }
    row.into_any_element()
}

fn count(id: ElementId, hidden: usize, ds: &Ds) -> AnyElement {
    let body = if hidden > 0 {
        Tag::new((id, "count"), format!("+{hidden}"))
            .icon_end(Icon::ChevronRight)
            .into_any_element()
    } else {
        icon_px(Icon::ChevronRight, ds.len(Length::IconSizeSm)).into_any_element()
    };
    div()
        .flex()
        .flex_none()
        .items_center()
        .text_color(ds.color(Color::TextSecondary))
        .child(body)
        .into_any_element()
}

/// The tail: the previous activity, the latest, and the line that joins them.
fn tail(
    id: &ElementId,
    previous: Option<SharedString>,
    latest: SharedString,
    (live, hidden): (bool, usize),
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let has_previous = previous.is_some();
    let earlier = previous.map(|text| row((id.clone(), "previous"), text, None, window, cx));
    let newest = row(
        (id.clone(), "latest"),
        latest,
        Some((live, hidden)),
        window,
        cx,
    );
    let ds = Ds::get(cx);
    let mut tail = div()
        .relative()
        .flex()
        .flex_col()
        .w_full()
        .min_w_0()
        .gap(ds.len(Length::SpaceXs))
        .pt(ds.len(Length::SpaceSm));
    if has_previous {
        let strong = convert::with_alpha(ds.color(Color::LineStrong), 0.9);
        tail = tail.child(
            div()
                .absolute()
                .top(ds.len(Length::SpaceXs) / 2.)
                .bottom(ds.len(Length::TagHeightSm) / 2.)
                .left(px(LINE_X))
                .w(px(1.))
                .rounded(ds.len(Length::RadiusPill))
                .bg(linear_gradient(
                    180.,
                    linear_color_stop(gpui::transparent_black(), 0.),
                    linear_color_stop(strong, 0.7),
                )),
        );
    }
    tail.children(earlier).child(newest).into_any_element()
}

/// The collapse chevron at the status line's trailing edge: it fades in and rises into place
/// while open, and out over the shorter exit curve.
fn collapse_icon(id: &ElementId, expanded: bool, window: &mut Window, cx: &mut App) -> AnyElement {
    let timing = {
        let ds = Ds::get(cx);
        if expanded {
            Timing::token(ds, DsDuration::MotionBase, Easing::MotionEaseStandard)
        } else {
            Timing::token(ds, DsDuration::MotionExitBase, Easing::MotionEaseAccelerate)
        }
    };
    let shown = anim::ramp(
        (id.clone(), "collapse"),
        (if expanded { 1. } else { 0. }, false),
        &timing,
        window,
        cx,
    );
    let ds = Ds::get(cx);
    let rise = f32::from(ds.len(Length::MotionDistanceXs));
    div()
        .relative()
        .top(px(rise * (1. - shown)))
        .opacity(shown)
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(CAPTION_LINE))
        .text_color(ds.color(Color::TextSecondary))
        .child(icon_px(Icon::ChevronUpIcon, ds.len(Length::IconSizeSm)))
        .into_any_element()
}

impl RenderOnce for WorkActivityDisclosure {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let id = self.id.clone();
        let collapse = collapse_icon(&id, self.expanded, window, cx);
        let ds = Ds::get(cx);
        let status = div()
            .flex()
            .items_center()
            .min_w_0()
            .gap(ds.len(Length::SpaceSm))
            .child(div().flex_1().min_w_0().child(strut::flex_scope(
                false,
                Typo::caption(self.status).truncate(),
            )))
            .child(collapse);
        let (previous, latest, live, hidden) = (
            self.previous.clone(),
            self.latest.clone(),
            self.live,
            self.hidden,
        );
        let swap_id = id.clone();
        let swap = RollingSwap::new(
            (id.clone(), "swap"),
            hidden.to_string(),
            move |window, cx| {
                tail(
                    &swap_id,
                    previous.clone(),
                    latest.clone(),
                    (live, hidden),
                    window,
                    cx,
                )
            },
        )
        .motion(self.live)
        .fill();
        let folded = Collapsible::new((id.clone(), "tail"), !self.expanded).child(swap);
        let mut toggle = Clickable::new((id.clone(), "toggle"))
            .variant(Variant::Text)
            .stretch()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .w_full()
                    .min_w_0()
                    .child(status)
                    .child(folded),
            );
        if let Some(on_toggle) = self.on_toggle.clone() {
            toggle = toggle.on_click(move |_, window, cx| on_toggle(window, cx));
        }
        let ds = Ds::get(cx);
        let details = Collapsible::new((id, "details"), self.expanded)
            .child(div().pt(ds.len(Length::SpaceSm)).children(self.children));
        div()
            .flex()
            .flex_col()
            .min_w_0()
            .child(toggle)
            .child(details)
    }
}
