//! The stack: every toast resolved for this frame and placed, the hover region around them, the
//! pointer listeners of a swipe and the timer that wakes the stack when a toast is due.
use std::time::Instant;

use gpui::{
    AnyElement, App, InteractiveElement as _, IntoElement as _, MouseMoveEvent, MouseUpEvent,
    ParentElement as _, StatefulInteractiveElement as _, Styled as _, Window, canvas, div, px,
};

use super::layout::{self, Frame, VISIBLE};
use super::{Store, view};
use crate::ui::context::Ds;

/// The stack's toasts and their pointer handling, `width` wide and as tall as what is visible.
pub(super) fn build(
    store: &Store,
    width: f32,
    now: Instant,
    ds: &Ds,
    window: &mut Window,
) -> AnyElement {
    let mut state = store.0.borrow_mut();
    let offsets = state.offsets();
    let expanded = state.expanded;
    let front_height = state
        .items
        .iter()
        .find(|item| item.removed_at.is_none())
        .map_or(0., |item| item.height.get());
    let place = view::Place { left: 0., width };
    let (mut busy, mut extent, mut visible) = (false, 0_f32, 0_usize);
    let mut toasts = Vec::new();
    for (index, item) in state.items.iter_mut().enumerate() {
        let frame = Frame {
            index,
            front_height,
            offset: offsets[index],
            expanded,
        };
        let resolved = layout::resolve(item, &frame, ds, now);
        let shown = item.removed_at.is_none() && index < VISIBLE;
        if shown {
            visible += 1;
            let bottom = resolved.y + resolved.height * (1. + resolved.scale) / 2.;
            extent = extent.max(bottom);
        }
        let loading = item.toast.kind == super::Kind::Loading && !ds.reduced_motion();
        busy |= resolved.moving || item.height.get() <= 0. || loading;
        let born = *item.born.get_or_insert(now);
        toasts.push(view::render(
            item,
            &resolved,
            &place,
            index == 0,
            store,
            (now, born),
            ds,
        ));
    }
    // The front toast is painted last (`z-index: count - index`).
    toasts.reverse();
    let mounted = state.items.len();
    drop(state);
    if busy {
        window.request_animation_frame();
    }
    let hover = store.clone();
    let region = div()
        .id("toaster")
        .relative()
        .w(px(width))
        .h(px(extent))
        .on_hover(move |hovered, window, _| {
            let mut state = hover.0.borrow_mut();
            state.hovered = *hovered;
            if *hovered {
                state.expanded = true;
            } else if !state.interacting {
                state.expanded = state.hotkey;
            }
            window.refresh();
        })
        .debug_selector(|| "toaster".to_owned())
        .children(toasts)
        .child(markers(mounted, visible, expanded))
        .child(pointer(store.clone()));
    region.into_any_element()
}

/// Zero-size markers the live harness can look for (`expect anchor toasts:3`).
fn markers(mounted: usize, visible: usize, expanded: bool) -> gpui::Div {
    let marker = |name: String| div().absolute().size_0().debug_selector(move || name);
    div()
        .absolute()
        .size_0()
        .child(marker(format!("toasts:{mounted}")))
        .child(marker(format!("toasts-visible:{visible}")))
        .child(marker(format!("toasts-expanded:{expanded}")))
}

/// The window-level pointer listeners of a swipe: it follows the pointer wherever it goes and
/// ends when the button is released (sonner captures the pointer).
fn pointer(store: Store) -> gpui::Canvas<()> {
    canvas(
        |_, _, _| (),
        move |_, (), window, _| {
            let moved = store.clone();
            window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, _| {
                if phase.capture() && moved.0.borrow_mut().move_swipe(event.position) {
                    window.refresh();
                }
            });
            let up = store.clone();
            window.on_mouse_event(move |_: &MouseUpEvent, phase, window, cx| {
                if phase.capture() {
                    let now = cx.background_executor().now();
                    up.0.borrow_mut().end_swipe(now);
                    window.refresh();
                }
            });
        },
    )
    .absolute()
    .size_0()
}

/// Wakes the window when the next timer or unmount is due, once for the earliest of them.
pub(super) fn schedule(store: &Store, now: Instant, window: &mut Window, cx: &mut App) {
    let (delay, store) = {
        let mut state = store.0.borrow_mut();
        let Some(next) = state.next_wake(now) else {
            return;
        };
        if state.wake.is_some_and(|at| at > now && at <= next) {
            return;
        }
        state.wake = Some(next);
        (next.saturating_duration_since(now), store.clone())
    };
    window
        .spawn(cx, async move |cx| {
            cx.background_executor()
                .timer(delay + std::time::Duration::from_millis(1))
                .await;
            store.0.borrow_mut().wake = None;
            cx.update(|window, _| window.refresh()).ok();
        })
        .detach();
}
