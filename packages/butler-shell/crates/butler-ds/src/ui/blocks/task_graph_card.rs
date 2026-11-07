//! DS TaskGraphCard (TaskGraphCard.tsx): one task in a task graph. A status glyph and a
//! two-line title, a meta line, the status Tag with the time, and the live step while the task
//! runs. A running task draws the Card's running ring. Read-only: activating only selects or
//! opens; it never edits the task.
//!
//! Also exported for the graph blocks: [`TaskGraphStatus`], [`TaskGraphStatusIcon`] (the glyph,
//! used by section rows), [`TaskGraphStepLine`] (the rolling step line, used in the detail) and
//! [`status_tone`].
use std::rc::Rc;

use gpui::{
    App, ElementId, IntoElement, ParentElement as _, RenderOnce, SharedString, Styled as _, Window,
    div, px,
};

use crate::tokens::{Color, Length};
use crate::ui::Icon;
use crate::ui::card::{Card, CardPadding};
use crate::ui::context::Ds;
use crate::ui::icon::icon_px;
use crate::ui::icon_slot::{IconSlot, SlotSize, SlotTone};
use crate::ui::layout::{Cross, Justify, Space, Stack};
use crate::ui::rolling_status_line::RollingStatusLine;
use crate::ui::rolling_swap::RollingSwap;
use crate::ui::spinner::Spinner;
use crate::ui::success_check::SuccessCheck;
use crate::ui::tag::{Size as TagSize, Tag, Tone as TagTone};
use crate::ui::typo::{Role, Tone, Typo, Wrap};

/// A task's state (`TaskGraphStatus` of `lib/taskGraphLayout.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TaskGraphStatus {
    Pending,
    Running,
    Review,
    Done,
    Failed,
    Blocked,
    Cancelled,
    Paused,
}

impl TaskGraphStatus {
    /// Every status, in the showcase order.
    pub const ALL: [Self; 8] = [
        Self::Pending,
        Self::Running,
        Self::Review,
        Self::Done,
        Self::Failed,
        Self::Blocked,
        Self::Cancelled,
        Self::Paused,
    ];
}

/// Tag tone for a task status: accent while live, danger when failed, warning when blocked.
pub fn status_tone(status: TaskGraphStatus) -> TagTone {
    match status {
        TaskGraphStatus::Running | TaskGraphStatus::Review => TagTone::Accent,
        TaskGraphStatus::Failed => TagTone::Danger,
        TaskGraphStatus::Blocked => TagTone::Warning,
        _ => TagTone::Neutral,
    }
}

/// Called with the task id when a card is activated.
pub type ActivateHandler = Rc<dyn Fn(&SharedString, &mut Window, &mut App)>;

/// One glyph per status. Running and done share a slot, so running to done draws the check
/// (`LoadingIndicator`: the check animates only when it saw the spinner first).
#[derive(IntoElement)]
pub struct TaskGraphStatusIcon {
    id: SharedString,
    status: TaskGraphStatus,
}

impl TaskGraphStatusIcon {
    /// `id` keys the spinner clock and the "saw it running" memory.
    pub fn new(id: impl Into<SharedString>, status: TaskGraphStatus) -> Self {
        Self {
            id: id.into(),
            status,
        }
    }
}

/// The height of `<Typo.Text tone>` around an icon (`TaskGraphStatusIcon`): the span is a block
/// of its own, its line box the taller of the glyph sitting on the baseline and the body strut,
/// so a 16px glyph in a 20px body line makes a box about 21px tall.
fn toned_height(side: f32, ds: &Ds, cx: &App) -> f32 {
    let Some(body) = Role::Body.tokens() else {
        return side;
    };
    let size = f32::from(ds.len(body.size));
    let line = f32::from(ds.len(body.line_height));
    let (ascent, descent) = Typo::extent(ds.body_font(), size, ds.number(body.weight), cx);
    let above = (line - (ascent + descent)) / 2. + ascent;
    above.max(side) + (line - above)
}

impl RenderOnce for TaskGraphStatusIcon {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let id = self.id;
        let loading = self.status == TaskGraphStatus::Running;
        let saw = window.use_keyed_state(format!("{id}-saw-loading"), cx, move |_, _| loading);
        if loading && !*saw.read(cx) {
            saw.update(cx, |saw, _| *saw = true);
        }
        let animate = *saw.read(cx);
        let ds = Ds::get(cx);
        let side = ds.len(Length::IconSizeMd);
        let glyph = |icon| icon_px(icon, side).into_any_element();
        let toned = |color: Color, icon| {
            div()
                .h(px(toned_height(f32::from(side), ds, cx)))
                .text_color(ds.color(color))
                .child(icon_px(icon, side))
                .into_any_element()
        };
        match self.status {
            TaskGraphStatus::Running => Spinner::new(format!("{id}-spinner"))
                .size(f32::from(side))
                .into_any_element(),
            TaskGraphStatus::Done => SuccessCheck::new(format!("{id}-check"))
                .ring()
                .size(f32::from(side))
                .animate_if(animate)
                .into_any_element(),
            TaskGraphStatus::Review => glyph(Icon::Eye),
            TaskGraphStatus::Failed => toned(Color::ColorDangerText, Icon::AlertCircle),
            TaskGraphStatus::Blocked => toned(Color::ColorWarningText, Icon::AlertCircle),
            TaskGraphStatus::Cancelled => glyph(Icon::CircleX),
            TaskGraphStatus::Paused => glyph(Icon::Minus),
            TaskGraphStatus::Pending => glyph(Icon::Circle),
        }
    }
}

/// The live step line of a running task: one line that rolls when the step changes.
#[derive(IntoElement)]
pub struct TaskGraphStepLine {
    id: ElementId,
    step: SharedString,
}

impl TaskGraphStepLine {
    /// `id` keys the roll; a new `step` rolls to it.
    pub fn new(id: impl Into<ElementId>, step: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            step: step.into(),
        }
    }
}

impl RenderOnce for TaskGraphStepLine {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let text = self.step.clone();
        RollingStatusLine::new().child(RollingSwap::new(self.id, self.step, move |_, _| {
            Typo::caption(text.clone())
                .tone(Tone::Secondary)
                .truncate()
                .into_any_element()
        }))
    }
}

#[derive(IntoElement)]
pub struct TaskGraphCard {
    task_id: SharedString,
    title: SharedString,
    status: TaskGraphStatus,
    status_label: SharedString,
    meta: Option<SharedString>,
    time: Option<SharedString>,
    step: Option<SharedString>,
    selected: bool,
    on_activate: Option<ActivateHandler>,
}

impl TaskGraphCard {
    /// `status_label` is the localized status word shown in the Tag. `task_id` keys the card
    /// and is passed to the activate handler.
    pub fn new(
        task_id: impl Into<SharedString>,
        title: impl Into<SharedString>,
        status: TaskGraphStatus,
        status_label: impl Into<SharedString>,
    ) -> Self {
        Self {
            task_id: task_id.into(),
            title: title.into(),
            status,
            status_label: status_label.into(),
            meta: None,
            time: None,
            step: None,
            selected: false,
            on_activate: None,
        }
    }

    /// Assignee and model, e.g. "Worker 3 · GPT-6 Luna" (or "Not assigned").
    pub fn meta(mut self, meta: impl Into<SharedString>) -> Self {
        self.meta = Some(meta.into());
        self
    }

    /// Elapsed or total time, tabular.
    pub fn time(mut self, time: impl Into<SharedString>) -> Self {
        self.time = Some(time.into());
        self
    }

    /// Current step of a running task (rolls on change); drawn only while running.
    pub fn step(mut self, step: impl Into<SharedString>) -> Self {
        self.step = Some(step.into());
        self
    }

    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    pub fn on_activate(
        mut self,
        handler: impl Fn(&SharedString, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_activate = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for TaskGraphCard {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let id = self.task_id;
        let running = self.status == TaskGraphStatus::Running;
        let head = Stack::row()
            .gap(Space::Sm)
            .cross(Cross::Start)
            .child(
                IconSlot::new()
                    .size(SlotSize::Md)
                    .min_line()
                    .tone(SlotTone::Tertiary)
                    .child(TaskGraphStatusIcon::new(
                        format!("{id}-status"),
                        self.status,
                    )),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(Typo::body(self.title).line_clamp(2)),
            );
        let foot = Stack::row()
            .justify(Justify::Between)
            .cross(Cross::Center)
            .gap(Space::Sm)
            .child(
                Tag::new(format!("{id}-tag"), self.status_label)
                    .size(TagSize::Sm)
                    .tone(status_tone(self.status)),
            )
            .children(self.time.map(|time| {
                Typo::caption(time)
                    .tone(Tone::Tertiary)
                    .tabular()
                    .wrap(Wrap::Nowrap)
            }));
        let step = self
            .step
            .filter(|_| running)
            .map(|step| TaskGraphStepLine::new(format!("{id}-step"), step));
        let body = Stack::new()
            .gap(Space::Xs)
            .child(head)
            .children(self.meta.map(|meta| {
                div()
                    .min_w_0()
                    .child(Typo::caption(meta).tone(Tone::Tertiary).truncate())
            }))
            .child(foot)
            .children(step);
        let mut card = Card::new(ElementId::Name(id.clone()))
            .interactive()
            .padding(CardPadding::Sm)
            .selected(self.selected);
        if running {
            card = card.running();
        }
        if let Some(handler) = self.on_activate {
            card = card.on_click(move |_, window, cx| handler(&id, window, cx));
        }
        card.child(body)
    }
}
