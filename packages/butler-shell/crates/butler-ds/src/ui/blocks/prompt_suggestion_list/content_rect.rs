//! `usePromptContentRect` and `useContentRectReport` (usePromptContentRect.ts): the header and
//! the visible suggestion cards as one rect, in window pixels, for a wallpaper that keeps the
//! text readable. gpui knows a box's place only while painting, so each box records its bounds
//! as it paints and a last canvas, painted after them, folds them into the rect and reports a
//! changed one once.
use std::cell::RefCell;
use std::rc::Rc;

use gpui::{
    AnyElement, App, Bounds, ElementId, Entity, IntoElement as _, Pixels, Styled as _, Window,
    canvas, px,
};

/// How much a measurement may drift before it counts as changed.
const EPSILON: f32 = 0.01;

/// What a wallpaper keeps readable: the header and the visible cards (`WallpaperContentRect`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ContentRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl ContentRect {
    fn differs(self, other: Self) -> bool {
        [
            (self.x, other.x),
            (self.y, other.y),
            (self.width, other.width),
            (self.height, other.height),
        ]
        .iter()
        .any(|(a, b)| (a - b).abs() > EPSILON)
    }
}

/// Where a recorder sits.
#[derive(Clone, Copy)]
pub(super) enum Slot {
    Header,
    Rail,
    /// A card; its bounds are taken as if it were not lifted by this many pixels (a hover
    /// lift is a transform, which the measurement ignores).
    Card(f32),
}

#[derive(Clone, Copy)]
struct Edges {
    left: f32,
    top: f32,
    right: f32,
    bottom: f32,
}

impl Edges {
    fn of(bounds: Bounds<Pixels>, lift: f32) -> Self {
        Self {
            left: f32::from(bounds.left()),
            top: f32::from(bounds.top()) + lift,
            right: f32::from(bounds.right()),
            bottom: f32::from(bounds.bottom()) + lift,
        }
    }

    /// Clipped to `clip`.
    fn within(self, clip: Self) -> Self {
        Self {
            left: self.left.max(clip.left),
            top: self.top.max(clip.top),
            right: self.right.min(clip.right),
            bottom: self.bottom.min(clip.bottom),
        }
    }

    fn visible(self) -> bool {
        self.right > self.left && self.bottom > self.top
    }
}

#[derive(Default)]
struct Boxes {
    header: Option<Edges>,
    rail: Option<Edges>,
    cards: Vec<Edges>,
}

/// The bounds of one frame's boxes, filled while it paints.
#[derive(Clone, Default)]
pub(super) struct Recording(Rc<RefCell<Boxes>>);

impl Recording {
    /// A canvas filling its (positioned) parent that records the parent's bounds in `slot`.
    pub(super) fn record(&self, slot: Slot) -> AnyElement {
        let boxes = self.0.clone();
        canvas(
            |_, _, _| (),
            move |bounds, (), _, _: &mut App| {
                let mut boxes = boxes.borrow_mut();
                match slot {
                    Slot::Header => boxes.header = Some(Edges::of(bounds, 0.)),
                    Slot::Rail => boxes.rail = Some(Edges::of(bounds, 0.)),
                    Slot::Card(lift) => boxes.cards.push(Edges::of(bounds, lift)),
                }
            },
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .into_any_element()
    }

    /// The header plus the cards as the rail shows them (clipped to its viewport), as one rect.
    fn measure(&self) -> Option<ContentRect> {
        let boxes = self.0.borrow();
        let clip = boxes.rail?;
        let all: Vec<Edges> = boxes
            .header
            .into_iter()
            .chain(boxes.cards.iter().map(|card| card.within(clip)))
            .filter(|edges| edges.visible())
            .collect();
        let fold =
            |pick: fn(&Edges) -> f32, join: fn(f32, f32) -> f32| all.iter().map(pick).reduce(join);
        let left = fold(|e| e.left, f32::min)?;
        let top = fold(|e| e.top, f32::min)?;
        Some(ContentRect {
            x: left,
            y: top,
            width: fold(|e| e.right, f32::max)? - left,
            height: fold(|e| e.bottom, f32::max)? - top,
        })
    }
}

/// What was last reported.
#[derive(Default)]
pub(super) struct Reported {
    sent: bool,
    rect: Option<ContentRect>,
}

impl Reported {
    fn is_current(&self, next: Option<ContentRect>) -> bool {
        self.sent
            && match (self.rect, next) {
                (Some(a), Some(b)) => !a.differs(b),
                (None, None) => true,
                _ => false,
            }
    }
}

type Report = Rc<dyn Fn(Option<ContentRect>, &mut Window, &mut App)>;

fn state(id: &ElementId, window: &mut Window, cx: &mut App) -> Entity<Reported> {
    window.use_keyed_state((id.clone(), "content-rect"), cx, |_, _| Reported::default())
}

/// The rect as of the last report (what a wallpaper drawn here is given).
pub(super) fn last(id: &ElementId, window: &mut Window, cx: &mut App) -> Option<ContentRect> {
    state(id, window, cx).read(cx).rect
}

/// The canvas that, once the boxes have painted, reports a new rect once and asks for another
/// frame so a wallpaper drawn in this list takes it.
pub(super) fn reporter(
    recording: Recording,
    id: &ElementId,
    on_report: Option<Report>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let state = state(id, window, cx);
    canvas(
        |_, _, _| (),
        move |_, (), window, cx: &mut App| {
            let next = recording.measure();
            if state.read(cx).is_current(next) {
                return;
            }
            state.update(cx, |reported, _| {
                reported.sent = true;
                reported.rect = next;
            });
            if let Some(report) = &on_report {
                report(next, window, cx);
            }
            window.request_animation_frame();
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size(px(1.))
    .into_any_element()
}
