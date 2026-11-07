//! Stacked sticky headers (`stickyDepth`, CollapsibleNavGroup.module.css:27-66): a header holds
//! at the scroller's top edge, one row below the sticky headers of the groups around it, until
//! its group scrolls out. gpui has no `position: sticky`, so the header is offset by how far
//! its group's top sits above that line, from the group's box and the scroller's top edge as
//! the last frame painted them (the SidebarShell sticky header's mechanism).
use gpui::{
    AnyElement, App, Bounds, ElementId, Entity, Hsla, IntoElement as _, Pixels, Styled as _,
    Window, canvas, div, px,
};

/// How far a measurement may drift before it counts as changed.
const EPSILON: f32 = 0.5;

/// A group's box in window space.
#[derive(Clone, Copy, Default)]
pub(super) struct Span {
    top: f32,
    height: f32,
}

/// The scroller the sticky groups stick to: place [`StickyScroll::recorder`] among the
/// scroller's rows, and give every sticky group a clone.
#[derive(Clone)]
pub struct StickyScroll {
    top: Entity<f32>,
    offset: f32,
}

impl StickyScroll {
    pub fn new(id: impl Into<ElementId>, window: &mut Window, cx: &mut App) -> Self {
        let top = window.use_keyed_state((id.into(), "sticky-viewport"), cx, |_, _| 0f32);
        Self { top, offset: 0. }
    }

    /// `--nav-sticky-offset`: where depth 0 holds, from the scroller's top edge.
    pub fn offset(mut self, offset: f32) -> Self {
        self.offset = offset;
        self
    }

    /// Records the scroller's top edge from the clip its rows paint under. It takes no room.
    pub fn recorder(&self) -> AnyElement {
        let state = self.top.clone();
        canvas(
            |_, _, _| (),
            move |_, (), window, cx| {
                let top = f32::from(window.content_mask().bounds.origin.y);
                if (*state.read(cx) - top).abs() > EPSILON {
                    state.update(cx, |state, _| *state = top);
                    window.request_animation_frame();
                }
            },
        )
        .absolute()
        .top_0()
        .left_0()
        .size_0()
        .into_any_element()
    }
}

/// A group's sticky settings.
#[derive(Clone)]
pub(super) struct Pin {
    pub(super) scroll: StickyScroll,
    pub(super) depth: usize,
    pub(super) surface: Option<Hsla>,
}

impl Pin {
    pub(super) fn span(&self, id: ElementId, window: &mut Window, cx: &mut App) -> Entity<Span> {
        window.use_keyed_state((id, "sticky-span"), cx, |_, _| Span::default())
    }

    /// How far the header sits below its natural place: the gap to the line it holds at,
    /// kept inside its group (the header stops with the group's last row).
    pub(super) fn offset(&self, span: Span, row: f32, cx: &App) -> f32 {
        let line = *self.scroll.top.read(cx) + self.scroll.offset + self.depth as f32 * row;
        (line - span.top).clamp(0., (span.height - row).max(0.))
    }
}

/// Records the box it fills (place it absolutely inside the group).
pub(super) fn span_recorder(state: Entity<Span>) -> AnyElement {
    canvas(
        |bounds: Bounds<Pixels>, _, _| bounds,
        move |_, bounds, window, cx| {
            let now = *state.read(cx);
            let span = Span {
                top: f32::from(bounds.origin.y),
                height: f32::from(bounds.size.height),
            };
            if (now.top - span.top).abs() > EPSILON || (now.height - span.height).abs() > EPSILON {
                state.update(cx, |state, _| *state = span);
                window.request_animation_frame();
            }
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
    .into_any_element()
}

/// `.stickyGroup > .content`: the rows clipped by `clip` px at the top, so they hide behind the
/// stuck header, with the focus-ring room left open on the other edges
/// (`clip-path: inset(clip -room -room)`). The negative margins pad the room back so the rows
/// keep their place.
pub(super) fn clipped(rows: AnyElement, clip: f32, room: Pixels) -> AnyElement {
    let inner = div().min_w_0().pt(room).mt(px(-clip)).child(rows);
    div()
        .min_w_0()
        .mx(-room)
        .mb(-room)
        .px(room)
        .pb(room)
        .mt(px(clip))
        .overflow_hidden()
        .child(inner)
        .into_any_element()
}
