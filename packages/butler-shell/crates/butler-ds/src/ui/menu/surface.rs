//! A menu level's surface (DropdownMenu.module.css `.content`): the glass with its rows, the
//! key handler and focus of the root, and the layers of the submenus open from it.
use std::rc::Rc;

use gpui::{
    AnyElement, App, FocusHandle, InteractiveElement as _, IntoElement as _, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, div, px,
};

use super::level::{Kind, Level, Row};
use super::rows::{self, At};
use super::runtime::SubRt;
use super::{Env, footprint};
use crate::tokens::{Color, Duration as DsDuration, Length};
use crate::ui::context::Ds;
use crate::ui::layer::Z;
use crate::ui::overlay::dismiss::{Dismissable, Handle};
use crate::ui::overlay::lifecycle::{Lifecycle, Phase, Spec as LifeSpec};
use crate::ui::overlay::motion::{self, Motion};
use crate::ui::overlay::place::{Align, Options, Padding, Side};
use crate::ui::overlay::popper::{Anchor, Popper};
use crate::ui::overlay::theme::Theme;
use crate::ui::tinted_glass::{GlassPadding, GlassRadius, TintedGlass};

/// `min-width: 8rem` of the surface at the DS View's 16px rem. // DS: DropdownMenu.module.css:2
const MIN_WIDTH: f32 = 128.;
/// The surface's padding. // DS: DropdownMenu.module.css:5
const PADDING: f32 = 6.;

pub(super) fn collision_padding(ds: &Ds) -> Padding {
    Padding::content(f32::from(ds.len(Length::TitlebarSafeAreaTop)))
}

/// The root surface with its focus and keys; `cap` is the tallest it may be (it scrolls).
pub(super) fn root(
    env: &Env,
    root: &Rc<Level>,
    cap: Option<f32>,
    handle: Option<&Handle>,
    focus: &FocusHandle,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let body = level(env, root, 0, &[], cap, None, handle, focus, window, cx);
    let (sheet, env, root) = (env.sheet, env.clone(), root.clone());
    // In a sheet the root is a box of the sheet's column, so its body can scroll.
    let el = if sheet {
        crate::ui::bottom_sheet::shrinking(div())
    } else {
        div()
    };
    el.track_focus(focus)
        .tab_stop(false)
        .on_key_down(move |event, window, cx| {
            if super::keys::handle(&env.menu, &root, event, window, cx) {
                cx.stop_propagation();
            }
        })
        .child(body)
        .into_any_element()
}

/// One level: its glass surface. `measure` reads the surface's rectangle (a submenu's, for the
/// grace polygon).
#[expect(
    clippy::too_many_arguments,
    reason = "one level of a recursive build: what it draws, where it is, and the window"
)]
fn level(
    env: &Env,
    level: &Rc<Level>,
    lvl: usize,
    path: &[usize],
    cap: Option<f32>,
    measure: Option<&Anchor>,
    handle: Option<&Handle>,
    focus: &FocusHandle,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let mut layers = Vec::new();
    for row in &level.rows {
        let Row::Item(item) = row else { continue };
        let Kind::Sub(sub_level) = &item.kind else {
            layers.push(None);
            continue;
        };
        let mut full = path.to_vec();
        full.push(item.idx);
        let sub = env.rt.update(cx, |rt, cx| rt.sub(&full, cx));
        let layer = sub_layer(env, sub_level, &full, &sub, handle, focus, window, cx);
        layers.push(Some((sub, layer)));
    }
    let ds = Ds::get(cx);
    let shown = env.rt.read(cx).shown(lvl);
    let mut layers = layers.into_iter();
    let mut children = Vec::new();
    for row in &level.rows {
        children.push(match row {
            Row::Label(text) => rows::label(ds, text),
            Row::Separator => rows::separator(ds),
            Row::Item(item) => {
                let (probe, sub) = match layers.next().flatten() {
                    Some((sub, layer)) => (Some(sub.trigger), layer),
                    None => (None, None),
                };
                let at = At {
                    lvl,
                    path,
                    shown: shown == Some(item.idx),
                    sub,
                    probe: probe.as_ref(),
                };
                rows::item(env, ds, item, at)
            }
        });
    }
    if env.sheet && lvl == 0 {
        return sheet_body(env, ds, children);
    }
    glass(env, ds, children, lvl, cap, measure)
}

/// The root level of a menu in a sheet: its rows scroll in the sheet's body.
fn sheet_body(env: &Env, ds: &Ds, rows: Vec<AnyElement>) -> AnyElement {
    let rt = env.rt.clone();
    crate::ui::bottom_sheet::body(
        SharedString::from(format!("{}-sheet-body", env.id)),
        None,
        ds,
    )
    .text_color(ds.color(Color::TextPrimary))
    .on_mouse_move(move |event, _, cx| {
        rt.update(cx, |rt, _| rt.track_pointer(f32::from(event.position.x)));
    })
    .children(rows)
    .into_any_element()
}

fn glass(
    env: &Env,
    ds: &Ds,
    rows: Vec<AnyElement>,
    lvl: usize,
    cap: Option<f32>,
    measure: Option<&Anchor>,
) -> AnyElement {
    let body = div()
        .flex()
        .flex_col()
        .p(px(PADDING))
        .text_color(ds.color(Color::TextPrimary))
        .children(rows);
    let body = match cap {
        Some(height) => {
            let border = f32::from(ds.len(Length::BorderHairline));
            div()
                .id(SharedString::from(format!("{}-scroll-{lvl}", env.id)))
                .max_h(px(height - 2. * border))
                .overflow_y_scroll()
                .child(body)
                .into_any_element()
        }
        None => body.into_any_element(),
    };
    let glass = TintedGlass::new()
        .radius(GlassRadius::Popover)
        .padding(GlassPadding::None)
        .child(body);
    let rt = env.rt.clone();
    let name = if lvl == 0 {
        "menu-content"
    } else {
        "menu-sub-content"
    };
    div()
        .relative()
        .flex()
        .flex_col()
        .min_w(px(MIN_WIDTH))
        .on_mouse_move(move |event, _, cx| {
            rt.update(cx, |rt, _| rt.track_pointer(f32::from(event.position.x)));
        })
        .child(glass)
        .children(measure.map(Anchor::probe))
        .debug_selector(move || name.to_owned())
        .into_any_element()
}

/// The layer of the submenu of trigger `path`: beside its row, right and start aligned, flipping
/// when there is no room. It stays mounted through its exit.
#[expect(
    clippy::too_many_arguments,
    reason = "one level of a recursive build: what it draws, where it is, and the window"
)]
fn sub_layer(
    env: &Env,
    sub_level: &Rc<Level>,
    path: &[usize],
    sub: &SubRt,
    parent: Option<&Handle>,
    focus: &FocusHandle,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let open = env.rt.read(cx).path.starts_with(path);
    let exit = Ds::get(cx).duration(DsDuration::MotionExitMenu);
    let spec = LifeSpec {
        modal: false,
        parent: parent.cloned(),
    };
    let synced = Lifecycle::sync(&sub.life, open, &spec, &sub.output, exit, window, cx);
    if synced.phase == Phase::Closed {
        return None;
    }
    let theme = Theme::current(cx);
    let resolved = sub.output.get();
    let cap = resolved.map(|resolved| resolved.available_height);
    let content = level(
        env,
        sub_level,
        path.len(),
        path,
        cap,
        Some(&sub.surface),
        synced.handle.as_ref(),
        focus,
        window,
        cx,
    );
    let side = resolved.map_or(Side::Right, |resolved| resolved.side);
    let origin = resolved.map_or((0., 0.5), |resolved| resolved.origin);
    let animated = motion::animate_glass(
        &format!("{}-sub-{path:?}", env.id),
        synced.phase,
        side,
        origin,
        Motion::MENU,
        content,
        (window, cx),
    )?;
    let frozen = match synced.phase {
        Phase::Exiting { frozen, .. } => frozen,
        _ => None,
    };
    let child = match synced.handle {
        Some(handle) => {
            let (menu, rt, depth) = (env.menu.clone(), env.rt.clone(), path.len());
            Dismissable::new(handle, animated, move |reason, window, cx| {
                if reason == crate::ui::overlay::dismiss::Reason::Escape {
                    menu.close(window, cx);
                } else {
                    rt.update(cx, |rt, cx| {
                        rt.close_below(depth - 1);
                        cx.notify();
                    });
                }
            })
            .focus(focus)
            .into_any_element()
        }
        None => animated,
    };
    let options = Options {
        side: Side::Right,
        align: Align::Start,
        side_offset: 0.,
        padding: collision_padding(Ds::get(cx)),
        avoid_collisions: true,
    };
    let popper =
        Popper::new(Z::Popover, &sub.trigger, options, &sub.output, theme, child).frozen(frozen);
    Some(footprint(popper))
}
