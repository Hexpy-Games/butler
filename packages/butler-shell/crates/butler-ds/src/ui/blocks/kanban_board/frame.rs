//! What a KanbanDragScope and a KanbanLane tell the lanes and cards below them (React's
//! `KanbanScopeContext` and `KanbanLaneContext`). The lanes and cards are built by the caller
//! before the scope exists, so they find their scope while they lay out: a [`Framed`] element
//! holds its frame in a global while its child lays out, prepares and paints, as `blocks::scope`
//! does for the shell's variables.
use gpui::{
    AnyElement, App, Bounds, Element, ElementId, GlobalElementId, InspectorElementId, IntoElement,
    LayoutId, Pixels, SharedString, Window,
};

use super::model::LaneLayout;
use super::session::Hub;

/// The lane a card is in.
#[derive(Clone)]
pub(super) struct LaneCtx {
    pub id: SharedString,
    pub layout: LaneLayout,
}

#[derive(Clone)]
enum Frame {
    Scope(Hub),
    Lane(LaneCtx),
}

#[derive(Default)]
struct Frames(Vec<Frame>);

impl gpui::Global for Frames {}

/// The enclosing scope's session, if the caller is inside one.
pub(super) fn hub(cx: &App) -> Option<Hub> {
    cx.try_global::<Frames>()?
        .0
        .iter()
        .rev()
        .find_map(|frame| match frame {
            Frame::Scope(hub) => Some(hub.clone()),
            Frame::Lane(_) => None,
        })
}

/// The enclosing droppable lane, if the caller is inside one.
pub(super) fn lane(cx: &App) -> Option<LaneCtx> {
    cx.try_global::<Frames>()?
        .0
        .iter()
        .rev()
        .find_map(|frame| match frame {
            Frame::Lane(lane) => Some(lane.clone()),
            Frame::Scope(_) => None,
        })
}

/// `child` laid out inside the scope of `hub`; the registry is rebuilt as it paints.
pub(super) fn in_scope(hub: Hub, child: impl IntoElement) -> Framed {
    Framed {
        frame: Frame::Scope(hub),
        child: Some(child.into_any_element()),
    }
}

/// `child` laid out inside the droppable lane `lane`.
pub(super) fn in_lane(lane: LaneCtx, child: impl IntoElement) -> Framed {
    Framed {
        frame: Frame::Lane(lane),
        child: Some(child.into_any_element()),
    }
}

pub(super) struct Framed {
    frame: Frame,
    child: Option<AnyElement>,
}

impl IntoElement for Framed {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

/// Runs `f` with the frame in effect.
fn within<R>(
    frame: &Frame,
    window: &mut Window,
    cx: &mut App,
    f: impl FnOnce(&mut Window, &mut App) -> R,
) -> R {
    cx.default_global::<Frames>().0.push(frame.clone());
    let out = f(window, cx);
    cx.default_global::<Frames>().0.pop();
    out
}

impl Element for Framed {
    type RequestLayoutState = AnyElement;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, AnyElement) {
        let mut child = self
            .child
            .take()
            .unwrap_or_else(|| gpui::Empty.into_any_element());
        let layout = within(&self.frame, window, cx, |window, cx| {
            child.request_layout(window, cx)
        });
        (layout, child)
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        child: &mut AnyElement,
        window: &mut Window,
        cx: &mut App,
    ) {
        within(&self.frame, window, cx, |window, cx| {
            child.prepaint(window, cx)
        });
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        child: &mut AnyElement,
        &mut (): &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        if let Frame::Scope(hub) = &self.frame {
            hub.borrow_mut().begin_frame();
        }
        within(&self.frame, window, cx, |window, cx| {
            child.paint(window, cx);
        });
    }
}
