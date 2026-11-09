//! KanbanLane (`KanbanBoard.tsx`): a lane of cards; with `lane_id` inside a KanbanDragScope it
//! takes dropped KanbanCards. The lane a drop would go to gets an accent border and a faint
//! accent fill (React fades them over `--motion-fast`; here they switch at once,
//! `ANIM-MIGRATE`).
use gpui::{
    AnyElement, App, Bounds, ElementId, InteractiveElement as _, IntoElement, ParentElement,
    Pixels, RenderOnce, SharedString, Styled as _, Window, canvas, div, px,
};

use super::frame::{self, LaneCtx, in_lane};
use super::model::{LaneLayout, Rect};
use super::session::Hub;
use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::layout::{Columns, Grid, Space};
use crate::ui::scroll::ScrollArea;
use crate::ui::typo::Typo;
use crate::ui::{convert, strut};

/// The accent share of the drop-target fill (`color-mix(in srgb, var(--accent) 5%, var(--surface))`).
const TARGET_SHARE: f32 = 0.05; // DS: KanbanBoard.module.css:80

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LaneHeight {
    /// `--kanban-lane-height`: the cards scroll under the title.
    #[default]
    Fixed,
    /// The lane grows with its cards from `--kanban-lane-min-height` (status lanes of a board).
    Content,
}

#[derive(IntoElement)]
pub struct KanbanLane {
    id: ElementId,
    title: SharedString,
    lane_id: Option<SharedString>,
    label: Option<SharedString>,
    height: LaneHeight,
    layout: LaneLayout,
    anchor: Option<SharedString>,
    children: Vec<AnyElement>,
}

impl KanbanLane {
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            lane_id: None,
            label: None,
            height: LaneHeight::Fixed,
            layout: LaneLayout::List,
            anchor: None,
            children: Vec::new(),
        }
    }

    /// Drop target id inside a KanbanDragScope; `on_move` reports it. Lanes without it take no cards.
    pub fn lane_id(mut self, lane_id: impl Into<SharedString>) -> Self {
        self.lane_id = Some(lane_id.into());
        self
    }

    /// Lane name for drag announcements; defaults to the title.
    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn height(mut self, height: LaneHeight) -> Self {
        self.height = height;
        self
    }

    pub fn layout(mut self, layout: LaneLayout) -> Self {
        self.layout = layout;
        self
    }

    /// Names the lane for the live harness (`debug_selector`).
    pub fn anchor(mut self, name: impl Into<SharedString>) -> Self {
        self.anchor = Some(name.into());
        self
    }
}

impl ParentElement for KanbanLane {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// Records the lane's box as it paints.
fn recorder(hub: &Hub, lane: &LaneCtx, label: &SharedString) -> AnyElement {
    let (hub, lane, label) = (hub.clone(), lane.clone(), label.clone());
    canvas(
        |bounds: Bounds<Pixels>, _, _| bounds,
        move |_, bounds, _, _| {
            hub.borrow_mut()
                .add_lane(lane.id, Rect::of(bounds), lane.layout, label);
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
    .into_any_element()
}

/// The drop line of an empty lane (`.list[data-drop]::before`), centered on the list's top edge.
fn start_line(ds: &Ds) -> gpui::Div {
    let line = ds.len(Length::KanbanDropLine);
    div()
        .absolute()
        .left_0()
        .right_0()
        .top(-(line / 2.))
        .h(line)
        .rounded(ds.len(Length::RadiusPill))
        .bg(ds.color(Color::Accent))
}

impl KanbanLane {
    /// The cards: a column (or a wrapping grid) with the drop line of an empty lane.
    fn cards(&mut self, start: bool, ds: &Ds) -> gpui::Div {
        let children = std::mem::take(&mut self.children);
        let list: AnyElement = match self.layout {
            LaneLayout::List => div()
                .flex()
                .flex_col()
                .min_w_0()
                .gap(Space::Sm.px(ds))
                .children(children)
                .into_any_element(),
            LaneLayout::Grid => {
                #[expect(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "a positive card width token in pixels"
                )]
                let min = ds.len(Length::KanbanCardMinWidth).as_f32().round() as u16;
                Grid::new((self.id.clone(), "cards"))
                    .columns(Columns::auto_fill_min(min))
                    .gap(Space::Sm)
                    .children(children)
                    .into_any_element()
            }
        };
        div()
            .relative()
            .min_w_0()
            .child(list)
            .children(start.then(|| start_line(ds)))
    }
}

impl RenderOnce for KanbanLane {
    fn render(mut self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let hub = frame::hub(cx);
        let ctx = self.lane_id.clone().map(|id| LaneCtx {
            id,
            layout: self.layout,
        });
        let live = hub.zip(ctx);
        let view = live
            .as_ref()
            .map(|(hub, _)| hub.borrow().view.clone())
            .unwrap_or_default();
        let target = live.as_ref().is_some_and(|(_, lane)| {
            view.target
                .as_ref()
                .is_some_and(|target| target.lane_id == lane.id)
        });
        let start = live
            .as_ref()
            .is_some_and(|(_, lane)| view.side(&lane.id, None).is_some());
        let ds = Ds::get(cx);
        let cards = self.cards(start, ds);
        let label = self.label.clone().unwrap_or_else(|| self.title.clone());
        let body: AnyElement = match self.height {
            LaneHeight::Fixed => ScrollArea::new((self.id.clone(), "scroll"))
                .fill()
                .child(cards)
                .into_any_element(),
            LaneHeight::Content => cards.into_any_element(),
        };
        let body = match &live {
            Some((_, lane)) => in_lane(lane.clone(), body).into_any_element(),
            None => body,
        };
        // ANIM-MIGRATE(the drop-target border and fill cross-fade over --motion-fast)
        let surface = ds.color(Color::Surface);
        let (border, fill) = match (target, self.height) {
            (true, _) => (
                ds.color(Color::Accent),
                Some(convert::mix(ds.color(Color::Accent), surface, TARGET_SHARE)),
            ),
            (false, LaneHeight::Content) => (ds.color(Color::Line), Some(surface)),
            (false, LaneHeight::Fixed) => (ds.color(Color::Line), None),
        };
        let mut inner = div().flex().flex_col().min_h_0().gap(Space::Sm.px(ds));
        if self.height == LaneHeight::Fixed {
            inner = inner.h(ds.len(Length::KanbanLaneHeight));
        }
        let mut lane = div()
            .id((self.id.clone(), "lane"))
            .relative()
            .w_full()
            .min_w_0()
            .p(ds.len(Length::SpaceMd))
            .border(px(1.)) // DS: SurfacePanel.module.css:5
            .border_color(border)
            .rounded(ds.len(Length::RadiusControl))
            .text_color(ds.color(Color::TextPrimary));
        if let Some(fill) = fill {
            lane = lane.bg(fill);
        }
        if self.height == LaneHeight::Content {
            lane = lane.min_h(ds.len(Length::KanbanLaneMinHeight));
        }
        if let Some(name) = self.anchor.take() {
            lane = lane.debug_selector(move || name.to_string());
        }
        let record = live.as_ref().map(|(hub, lane)| recorder(hub, lane, &label));
        let lane = lane
            .child(
                inner
                    .child(Typo::panel_section_title(self.title.clone()))
                    .child(body),
            )
            .children(record);
        strut::scope(true, strut::container(lane, ds))
    }
}
