//! ImageViewerSurface: the viewer's layout without the overlay: a bar (position, zoom, actions,
//! close), the picture fitted to the stage with previous and next on its sides, and the caption
//! with its source line. `ImageViewer` draws it over the window; previews draw it `contained`.
use gpui::{
    AnyElement, App, Bounds, Corners, ElementId, Entity, InteractiveElement as _, IntoElement,
    KeyDownEvent, MouseButton, MouseDownEvent, MouseMoveEvent, ParentElement, Pixels, Point,
    RenderOnce, ScrollWheelEvent, StatefulInteractiveElement as _, Styled as _, Window, canvas,
    div, px,
};

use super::chrome::{Chrome, bar, caption, fit_clamp, nav, picture, pointer_offset};
use super::zoom::{DOUBLE_CLICK_ZOOM, FIT, MAX_ZOOM, MIN_ZOOM, View, ZOOM_STEP, zoom_at};
use super::{Handler, ViewerImage, ViewerLabels};
use crate::tokens::{Color, Length};
use crate::ui::Icon;
use crate::ui::context::Ds;
use crate::ui::liquid_glass::{self, LiquidGlass};
use crate::ui::media_frame::{Load, resolve};

/// A drag of a zoomed picture: the pointer and the view where it started.
#[derive(Clone, Copy, Default)]
struct Drag {
    from: Option<(Point<Pixels>, View)>,
}

#[derive(IntoElement)]
pub struct ImageViewerSurface {
    pub(super) id: ElementId,
    pub(super) image: ViewerImage,
    pub(super) position: (usize, usize),
    pub(super) labels: ViewerLabels,
    actions: Vec<AnyElement>,
    pub(super) on_previous: Option<Handler>,
    pub(super) on_next: Option<Handler>,
    pub(super) on_close: Option<Handler>,
    contained: bool,
    autofocus: bool,
}

impl ImageViewerSurface {
    pub fn new(
        id: impl Into<ElementId>,
        image: ViewerImage,
        position: (usize, usize),
        labels: ViewerLabels,
    ) -> Self {
        Self {
            id: id.into(),
            image,
            position,
            labels,
            actions: Vec::new(),
            on_previous: None,
            on_next: None,
            on_close: None,
            contained: false,
            autofocus: false,
        }
    }

    /// The surface paints its own scrim inside a positioned parent (previews).
    pub fn contained(mut self) -> Self {
        self.contained = true;
        self
    }

    pub fn actions(mut self, actions: Vec<AnyElement>) -> Self {
        self.actions = actions;
        self
    }

    pub fn on_previous(mut self, handler: Option<Handler>) -> Self {
        self.on_previous = handler;
        self
    }

    pub fn on_next(mut self, handler: Option<Handler>) -> Self {
        self.on_next = handler;
        self
    }

    pub fn on_close(mut self, handler: Option<Handler>) -> Self {
        self.on_close = handler;
        self
    }

    /// Takes keyboard focus the first time it is drawn (the modal puts it on Close in React).
    pub fn take_focus(mut self, _: &mut Window, _: &mut App) -> Self {
        self.autofocus = true;
        self
    }
}

/// The entities one surface keeps: the zoom view, a drag in progress and the stage's bounds.
#[derive(Clone)]
struct State {
    view: Entity<View>,
    drag: Entity<Drag>,
    stage: Entity<Bounds<Pixels>>,
}

impl State {
    /// The surface `id`'s entities; a new picture (`index`) starts back at fit.
    fn keyed(id: &ElementId, index: usize, window: &mut Window, cx: &mut App) -> Self {
        let state = Self {
            view: window.use_keyed_state((id.clone(), "view"), cx, |_, _| FIT),
            drag: window.use_keyed_state((id.clone(), "drag"), cx, |_, _| Drag::default()),
            stage: window.use_keyed_state((id.clone(), "stage"), cx, |_, _| Bounds::default()),
        };
        let shown = window.use_keyed_state((id.clone(), "shown"), cx, |_, _| index);
        if *shown.read(cx) != index {
            shown.update(cx, |shown, _| *shown = index);
            state.view.update(cx, |view, _| *view = FIT);
        }
        state
    }
}

/// The stage's centre in window coordinates.
fn centre(bounds: Bounds<Pixels>) -> (f32, f32) {
    (
        f32::from(bounds.origin.x + bounds.size.width / 2.),
        f32::from(bounds.origin.y + bounds.size.height / 2.),
    )
}

/// Zoom with the wheel (Cmd or Ctrl), pan by dragging, double click to zoom in or back to fit.
fn pointer_handlers(
    el: gpui::Stateful<gpui::Div>,
    state: &State,
    natural: Option<(f32, f32)>,
) -> gpui::Stateful<gpui::Div> {
    let (wheel, down, moved, up, click) = (
        state.clone(),
        state.clone(),
        state.clone(),
        state.clone(),
        state.clone(),
    );
    el.on_scroll_wheel(move |event: &ScrollWheelEvent, _, cx| {
        if !(event.modifiers.platform || event.modifiers.control) {
            return;
        }
        let bounds = *wheel.stage.read(cx);
        let dy = f32::from(event.delta.pixel_delta(px(1.)).y);
        wheel.view.update(cx, |view, cx| {
            let to = (view.scale * (-dy * 0.01).exp()).clamp(MIN_ZOOM, MAX_ZOOM);
            let at = pointer_offset(event.position, centre(bounds));
            *view = fit_clamp(zoom_at(*view, to, at), natural, bounds);
            cx.notify();
        });
    })
    .on_mouse_down(MouseButton::Left, move |event: &MouseDownEvent, _, cx| {
        cx.stop_propagation();
        let current = *down.view.read(cx);
        down.drag
            .update(cx, |drag, _| drag.from = Some((event.position, current)));
    })
    .on_mouse_move(move |event: &MouseMoveEvent, _, cx| {
        let Some((from, start)) = moved.drag.read(cx).from else {
            return;
        };
        if start.scale <= 1. {
            return;
        }
        let bounds = *moved.stage.read(cx);
        moved.view.update(cx, |view, cx| {
            let next = View {
                x: start.x + f32::from(event.position.x - from.x),
                y: start.y + f32::from(event.position.y - from.y),
                ..start
            };
            *view = fit_clamp(next, natural, bounds);
            cx.notify();
        });
    })
    .on_mouse_up(MouseButton::Left, move |_, _, cx| {
        up.drag.update(cx, |drag, _| drag.from = None);
    })
    .on_click(move |event, _, cx| {
        let Some(position) = event.mouse_position().filter(|_| event.click_count() == 2) else {
            return;
        };
        let bounds = *click.stage.read(cx);
        click.view.update(cx, |view, cx| {
            *view = if view.scale > 1. {
                FIT
            } else {
                let at = pointer_offset(position, centre(bounds));
                fit_clamp(zoom_at(*view, DOUBLE_CLICK_ZOOM, at), natural, bounds)
            };
            cx.notify();
        });
    })
}

/// The stage: the picture, with zoom (the wheel with Cmd or Ctrl, a double click), pan (a drag)
/// and the side buttons.
fn stage(
    surface: &ImageViewerSurface,
    state: &State,
    (picture, natural, current): (Option<AnyElement>, Option<(f32, f32)>, View),
    ds: &Ds,
) -> gpui::Stateful<gpui::Div> {
    let id = surface.id.clone();
    let record = state.stage.clone();
    let recorder = canvas(
        |bounds, _, _| bounds,
        move |bounds, _, window, cx| {
            if *record.read(cx) != bounds {
                record.update(cx, |seen, _| *seen = bounds);
                crate::ui::motion::remeasure(window);
            }
        },
    )
    .absolute()
    .size_full();
    let anchor = format!("{id}-stage");
    let mut el = div()
        .id((id.clone(), "stage"))
        .debug_selector(move || anchor.clone())
        .relative()
        .flex_1()
        .min_h_0()
        .min_w_0()
        .overflow_hidden()
        .child(recorder)
        .children(picture);
    el = pointer_handlers(el, state, natural);
    el = if current.scale > 1. {
        el.cursor_grab()
    } else {
        el.cursor_pointer()
    };
    if surface.position.1 > 1 {
        let labels = &surface.labels;
        el = el
            .child(nav(
                &id,
                "previous",
                &labels.previous,
                Icon::ArrowLeft,
                surface.on_previous.clone(),
                ds,
            ))
            .child(nav(
                &id,
                "next",
                &labels.next,
                Icon::ChevronRight,
                surface.on_next.clone(),
                ds,
            ));
    }
    el
}

/// The keys: arrows page, Escape closes, `+`, `-` and `0` zoom.
fn keys(
    (previous, next, close): (Option<Handler>, Option<Handler>, Option<Handler>),
    view: Entity<View>,
) -> impl Fn(&KeyDownEvent, &mut Window, &mut App) + 'static {
    move |event, window, cx| {
        let key = event.keystroke.key.as_str();
        let step = match key {
            "left" => previous.as_ref(),
            "right" => next.as_ref(),
            "escape" => close.as_ref(),
            _ => None,
        };
        if let Some(step) = step {
            step(window, cx);
            return;
        }
        if event.keystroke.modifiers.platform || event.keystroke.modifiers.control {
            return;
        }
        let factor = match key {
            "+" | "=" => Some(ZOOM_STEP),
            "-" => Some(1. / ZOOM_STEP),
            _ => None,
        };
        view.update(cx, |view, cx| {
            match (factor, key) {
                (Some(factor), _) => {
                    let to = (view.scale * factor).clamp(MIN_ZOOM, MAX_ZOOM);
                    *view = zoom_at(*view, to, (0., 0.));
                }
                (None, "0") => *view = FIT,
                _ => return,
            }
            cx.notify();
        });
    }
}

/// The modal's scrim: Liquid Glass over the page behind it (`over_content`: nothing else is
/// glass under it).
fn scrim(ds: &Ds) -> gpui::Canvas<Bounds<Pixels>> {
    let dark = ds.dark();
    let glass = LiquidGlass::over_content().adapt(ds);
    canvas(
        |bounds, _, _| bounds,
        move |bounds, _, window, _| {
            liquid_glass::paint(bounds, Corners::default(), dark, glass, window);
        },
    )
}

impl RenderOnce for ImageViewerSurface {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let id = self.id.clone();
        let state = State::keyed(&id, self.position.0, window, cx);
        let (bounds, current) = (*state.stage.read(cx), *state.view.read(cx));
        let load = resolve(&(id.clone(), "picture").into(), &self.image.src, window, cx);
        let ds = Ds::get(cx);
        let actions = std::mem::take(&mut self.actions);
        let header = bar(
            &Chrome {
                surface: &self,
                view: &state.view,
                current,
            },
            actions,
            ds,
        );
        let natural = match &load {
            Load::Ready(data) => {
                let size = data.size(0);
                Some((size.width.0 as f32, size.height.0 as f32))
            }
            _ => None,
        };
        let shown_picture = picture(&self.image, &self.labels, (bounds.size, current), &load, ds);
        let stage_el = stage(&self, &state, (shown_picture, natural, current), ds);
        let handle = window
            .use_keyed_state((id.clone(), "focus"), cx, |_, cx| cx.focus_handle())
            .read(cx)
            .clone();
        let taken = window.use_keyed_state((id.clone(), "focused"), cx, |_, _| false);
        if self.autofocus && !*taken.read(cx) {
            taken.update(cx, |taken, _| *taken = true);
            let focus = handle.clone();
            window.defer(cx, move |window, cx| focus.focus(window, cx));
        }
        let ds = Ds::get(cx);
        let gutter = ds.len(Length::Space3);
        let top = ds.len(Length::TitlebarSafeAreaTop).max(gutter);
        let close = self.on_close.clone();
        let anchor = id.to_string();
        let mut root = div()
            .id((id.clone(), "surface"))
            .debug_selector(move || anchor.clone())
            .relative()
            .flex()
            .flex_col()
            .size_full()
            .min_w_0()
            .min_h_0()
            .gap(gutter)
            .px(gutter)
            .pt(top)
            .pb(gutter)
            .track_focus(&handle)
            .children((!self.contained).then(|| scrim(ds).absolute().size_full()))
            .child(header)
            .child(stage_el)
            .children(caption(&self.image, ds));
        if self.contained {
            root = root
                .h(px(420.))
                .rounded(ds.len(Length::RadiusPanel))
                .bg(ds.color(Color::ImageViewerOverlayBg));
        }
        let keyed = (
            self.on_previous.clone(),
            self.on_next.clone(),
            self.on_close.clone(),
        );
        root.on_key_down(keys(keyed, state.view.clone()))
            .on_click(move |_, window, cx| {
                if let Some(close) = &close {
                    close(window, cx);
                }
            })
    }
}
