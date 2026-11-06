//! DS WorkerActivityRow and WorkerActivityPanel (WorkerActivityRow.tsx, WorkerActivityPanel.tsx and
//! their CSS): a worker's line with its five-step phase rail, and the composer adjunct that lists
//! them. The rail's active step pulses; a worker that completes while visible pulses its icon once.
use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement, ParentElement, RenderOnce,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, div, relative,
};

mod rail;

use super::composer_adjunct_panel::ComposerAdjunctPanel;
use crate::tokens::{Color, Duration as DsDuration, Easing, Length};
use crate::ui::context::Ds;
use crate::ui::convert;
use crate::ui::strut;
use crate::ui::typo::{Tone, Typo, Weight};

type Toggle = std::rc::Rc<dyn Fn(&mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct WorkerActivityRow {
    id: SharedString,
    title: SharedString,
    description: Option<SharedString>,
    meta: Option<SharedString>,
    icon: Option<AnyElement>,
    actions: Option<AnyElement>,
    details: Option<AnyElement>,
    phase: Option<SharedString>,
    show_rail: bool,
    compact: bool,
    depth: usize,
    on_toggle: Option<Toggle>,
}

impl WorkerActivityRow {
    pub fn new(id: impl Into<SharedString>, title: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            description: None,
            meta: None,
            icon: None,
            actions: None,
            details: None,
            phase: None,
            show_rail: true,
            compact: false,
            depth: 0,
            on_toggle: None,
        }
    }

    pub fn description(mut self, text: impl Into<SharedString>) -> Self {
        self.description = Some(text.into());
        self
    }

    pub fn meta(mut self, text: impl Into<SharedString>) -> Self {
        self.meta = Some(text.into());
        self
    }

    pub fn icon(mut self, icon: impl IntoElement) -> Self {
        self.icon = Some(icon.into_any_element());
        self
    }

    /// Icon buttons at the line's end.
    pub fn actions(mut self, actions: impl IntoElement) -> Self {
        self.actions = Some(actions.into_any_element());
        self
    }

    pub fn details(mut self, details: impl IntoElement) -> Self {
        self.details = Some(details.into_any_element());
        self
    }

    /// `orienting` to `reporting` (and the backend's `inspecting`, `committing`, `consolidating`),
    /// or `complete`, `failed`, `cancelled`.
    pub fn phase(mut self, phase: impl Into<SharedString>) -> Self {
        self.phase = Some(phase.into());
        self
    }

    pub fn show_phase_rail(mut self, show: bool) -> Self {
        self.show_rail = show;
        self
    }

    pub fn compact(mut self) -> Self {
        self.compact = true;
        self
    }

    pub fn depth(mut self, depth: usize) -> Self {
        self.depth = depth;
        self
    }

    /// Makes the heading a disclosure button.
    pub fn on_toggle(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_toggle = Some(std::rc::Rc::new(handler));
        self
    }
}

/// How far the one-shot completion pulse has come (0 to 1), or `None` when it is not running: it
/// starts when `phase` turns `complete` after mounting. // DS: WorkerActivityRow.tsx:117
fn completed_now(
    id: &SharedString,
    phase: Option<&str>,
    window: &mut Window,
    cx: &mut App,
) -> Option<f32> {
    let previous =
        window.use_keyed_state(format!("{id}-phase"), cx, |_, _| phase.map(str::to_owned));
    let began =
        window.use_keyed_state(
            format!("{id}-done-at"),
            cx,
            |_, _| None::<std::time::Instant>,
        );
    let now = cx.background_executor().now();
    let before = previous.read(cx).clone();
    if phase == Some("complete") && before.as_deref().is_some_and(|p| p != "complete") {
        began.update(cx, |at, _| *at = Some(now));
    }
    if before.as_deref() != phase {
        previous.update(cx, |p, _| *p = phase.map(str::to_owned));
    }
    let started = (*began.read(cx))?;
    let (length, ease) = {
        let ds = Ds::get(cx);
        let reduced = ds.reduced_motion();
        let token = if reduced {
            DsDuration::MotionFast
        } else {
            DsDuration::MotionDeliberate
        };
        (
            ds.duration(token),
            ds.tokens().ease(Easing::MotionEaseDecelerate),
        )
    };
    let t = now.saturating_duration_since(started).as_secs_f32() / length.as_secs_f32();
    if t >= 1. {
        began.update(cx, |at, _| *at = None);
        return None;
    }
    window.request_animation_frame();
    Some(convert::ease_at(ease, t))
}

impl RenderOnce for WorkerActivityRow {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let phase = self.phase.clone();
        let finishing = completed_now(&self.id, phase.as_deref(), window, cx);
        let rail = (self.show_rail)
            .then(|| {
                phase
                    .as_deref()
                    .map(|p| rail::rail(p, finishing, window, cx))
            })
            .flatten();
        let ds = Ds::get(cx);
        let heading_kind = heading_line(self.title, self.meta, self.description.as_ref(), ds);
        let heading = match self.on_toggle.clone() {
            Some(toggle) => div()
                .id(SharedString::from(format!("{}-toggle", self.id)))
                .min_w_0()
                .cursor_pointer()
                .on_click(move |_, window, cx| toggle(window, cx))
                .child(heading_kind)
                .into_any_element(),
            None => div().min_w_0().child(heading_kind).into_any_element(),
        };
        let header = div()
            .flex()
            .items_center()
            .justify_between()
            .gap(ds.len(Length::Space2))
            .min_w_0()
            .child(div().flex_1().min_w_0().child(heading))
            // The action buttons (the xs button) set the header's height.
            .children(self.actions.map(|actions| {
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .h(ds.len(Length::ControlHeightXs))
                    .child(actions)
            }));
        let body = div()
            .flex()
            .flex_col()
            .min_w_0()
            .gap(ds.len(Length::Space1))
            .child(header)
            .children(rail)
            .children(self.details.map(|details| {
                div()
                    .pt(ds.len(Length::Space2))
                    .max_w(relative(1.))
                    .overflow_hidden()
                    .child(details)
            }));
        let body = if self.depth > 0 {
            body.pl(ds.len(Length::Space3))
                .border_l(ds.len(Length::BorderHairline))
                .border_color(ds.color(Color::Line))
        } else {
            body
        };
        let icon = self.icon.map(|icon| leading_icon(icon, finishing, ds));
        let mut root = div()
            .flex()
            .items_start()
            .min_w_0()
            .gap(ds.len(Length::Space2))
            .text_color(ds.color(Color::TextPrimary));
        if !self.compact {
            root = root.py(ds.len(Length::Space1));
        }
        if self.depth > 0 {
            root = root.pl(ds.len(Length::Space3));
        }
        root.children(icon)
            .child(div().flex_1().min_w_0().child(body))
    }
}

#[derive(IntoElement)]
pub struct WorkerActivityPanel {
    id: ElementId,
    heading: Option<SharedString>,
    summary: Option<SharedString>,
    items: Vec<WorkerActivityRow>,
}

impl WorkerActivityPanel {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            heading: None,
            summary: None,
            items: Vec::new(),
        }
    }

    pub fn heading(mut self, heading: impl Into<SharedString>) -> Self {
        self.heading = Some(heading.into());
        self
    }

    pub fn collapsed_summary(mut self, summary: impl Into<SharedString>) -> Self {
        self.summary = Some(summary.into());
        self
    }

    pub fn item(mut self, row: WorkerActivityRow) -> Self {
        self.items.push(row);
        self
    }
}

impl RenderOnce for WorkerActivityPanel {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        if self.items.is_empty() {
            return div().into_any_element();
        }
        let gap = Ds::get(cx).len(Length::SpaceSm);
        let mut panel = ComposerAdjunctPanel::new(self.id);
        if let Some(heading) = self.heading {
            panel = panel.heading(heading);
        }
        if let Some(summary) = self.summary {
            panel = panel.collapsed_summary(summary);
        }
        let list = div()
            .flex()
            .flex_col()
            .min_w_0()
            .gap(gap)
            .children(self.items.into_iter().map(WorkerActivityRow::compact));
        panel.child(list).into_any_element()
    }
}

/// The heading line: the title, then `meta:` and the one-line description, all regular weight.
fn heading_line(
    title: SharedString,
    meta: Option<SharedString>,
    description: Option<&SharedString>,
    ds: &Ds,
) -> gpui::Div {
    use crate::ui::typo::Wrap;
    let regular = Weight::Regular;
    let mut line = div()
        .flex()
        .items_center()
        .overflow_hidden()
        .gap(ds.len(Length::Space1))
        .child(
            div()
                .flex_none()
                .child(Typo::body(title).weight(regular).wrap(Wrap::Nowrap)),
        );
    if let Some(meta) = meta {
        let text = if description.is_some() {
            format!("{meta}:")
        } else {
            meta.to_string()
        };
        line = line.child(
            div().flex_none().child(strut::flex_scope(
                false,
                Typo::caption(text)
                    .tone(Tone::Tertiary)
                    .weight(regular)
                    .wrap(Wrap::Nowrap),
            )),
        );
    }
    if let Some(description) = description {
        line = line.child(
            div().flex_1().min_w_0().child(strut::flex_scope(
                false,
                Typo::caption(description.clone())
                    .tone(Tone::Tertiary)
                    .weight(regular)
                    .truncate(),
            )),
        );
    }
    line
}

/// The worker's icon: tertiary, in the success colour while the completion pulse runs.
fn leading_icon(icon: AnyElement, finishing: Option<f32>, ds: &Ds) -> gpui::Div {
    let ink = if finishing.is_some() {
        ds.color(Color::ColorSuccessText)
    } else {
        ds.color(Color::TextTertiary)
    };
    div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(ds.len(Length::TypoBodyLineHeight))
        .text_color(ink)
        .opacity(finishing.unwrap_or(1.))
        .child(icon)
}
