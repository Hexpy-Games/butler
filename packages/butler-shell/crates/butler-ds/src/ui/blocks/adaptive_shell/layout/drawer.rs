//! The drawer layout (AdaptiveShell.module.css `[data-panel-layout="drawer"]`): the sidebar and
//! the inspector slide in over the workspace under a scrim; below 641px the open sidebar pushes
//! the workspace aside, above it the workspace narrows beside it. The inspector's docked form
//! lives here too, as it shares the panel's slide.
use gpui::{
    AnyElement, App, InteractiveElement as _, IntoElement as _, ParentElement as _, Styled as _,
    div, px,
};

use super::{AdaptiveShell, Ctx, NAV_FILLS, panel_rows, root_box, shell_tones, workspace_box};
use crate::tokens::{Color, Duration as DsDuration, Easing, Length};
use crate::ui::blocks::adaptive_shell::parts;
use crate::ui::blocks::responsive::COMPACT_MAX;
use crate::ui::blocks::scope::{self, Spec};
use crate::ui::context::Ds;
use crate::ui::motion::{Props, Timing};

/// The inspector drawer is at most this share of a tablet window (`min(var(--right-panel-width), 92vw)`).
const INSPECTOR_SHARE: f32 = 0.92; // DS: AdaptiveShell.module.css:259

fn sidebar_width(shell: &AdaptiveShell, compact: bool, ds: &Ds) -> f32 {
    if compact && shell.compact_sidebar_full_width {
        shell.window.width
    } else {
        f32::from(ds.len(Length::AdaptiveDrawerWidth))
    }
}

fn inspector_width(shell: &AdaptiveShell, compact: bool, ds: &Ds) -> f32 {
    if compact {
        f32::from(ds.len(Length::AdaptiveInspectorWidth))
    } else {
        shell.right_width.min(shell.window.width * INSPECTOR_SHARE)
    }
}

pub(super) fn root(shell: &mut AdaptiveShell, ctx: &Ctx, cx: &mut App) -> AnyElement {
    let ds = Ds::get(cx);
    let t = &ctx.t;
    let compact = shell.window.width <= COMPACT_MAX;
    let (dw, iw) = (
        sidebar_width(shell, compact, ds),
        inspector_width(shell, compact, ds),
    );
    let reduced = ds.reduced_motion();
    let timing = Timing::token(
        ds,
        DsDuration::AdaptivePanelDuration,
        Easing::AdaptivePanelEasing,
    );
    let layout = gpui::LayoutMotion {
        duration_ms: if reduced { 0 } else { timing.ms() },
        easing: timing.easing(),
    };
    let spacer = if !compact && shell.left_open { dw } else { 0. };
    let workspace = workspace_box(shell, ctx, (0., 0.), ds);
    let cell = div()
        .id((shell.id.clone(), "drawer-workspace"))
        .layout_motion(layout)
        .relative()
        .flex_auto()
        .min_w_0()
        .h_full()
        .child(workspace);
    let cell = if compact && !reduced {
        t.left.apply(
            cell,
            &timing,
            &Props {
                offset: Some((gpui::point(px(0.), px(0.)), gpui::point(px(dw), px(0.)))),
                ..Default::default()
            },
        )
    } else {
        cell
    };
    let mut root = root_box(shell, ctx, ds)
        .flex()
        .flex_row()
        .child(
            div()
                .id((shell.id.clone(), "drawer-track"))
                .layout_motion(layout)
                .w(px(spacer))
                .flex_none(),
        )
        .child(cell);
    let backdrop = shell
        .scrim
        .take()
        .filter(|_| t.scrim.target() > 0. || t.scrim.moving(&timing))
        .map(|dismiss| {
            let open = shell.left_open || ctx.inspector_open;
            t.scrim.apply(
                div().absolute().size_full().child(parts::scrim(
                    (shell.id.clone(), "scrim"),
                    1.,
                    open.then_some(dismiss),
                    ds,
                )),
                &timing,
                &Props {
                    opacity: Some((0., 1.)),
                    ..Default::default()
                },
            )
        });
    root = root.children(backdrop);
    root = root.children(sidebar(shell, (ctx, ds), dw));
    root = root.children(inspector(shell, ctx, (iw, compact), ds));
    if !ctx.inspector_open {
        root = root.children(shell.chrome.take());
    }
    root.into_any_element()
}

/// The sidebar drawer: `left: 0`, translated out by its own width while closed.
fn sidebar(shell: &mut AdaptiveShell, (ctx, ds): (&Ctx, &Ds), width: f32) -> Option<AnyElement> {
    let t = &ctx.t;
    let timing = Timing::token(
        ds,
        DsDuration::AdaptivePanelDuration,
        Easing::AdaptivePanelEasing,
    );
    let fade = Timing::token(ds, DsDuration::MotionExitFast, Easing::MotionEaseStandard);
    if !shell.left_open && !t.left.moving(&timing) && !t.left_fade.moving(&fade) {
        return None;
    }
    let content = shell.sidebar.take()?;
    let spec = Spec {
        remap: [shell_tones(), panel_rows()].concat(),
        nav_fills: Some(NAV_FILLS),
        ..Spec::default()
    };
    // A closing sidebar takes no clicks while it slides away (`.sidebar[data-open=false]`); gpui has no
    // `pointer-events: none`, so a cover takes them.
    Some(
        drawer_panel(false, width, (ctx, ds), scope::scoped(spec, content))
            .children((!shell.left_open).then(|| div().absolute().inset_0().occlude()))
            .into_any_element(),
    )
}

/// A drawer: `position: fixed` at one window edge on the panel surface; it slides in from its
/// edge, or only fades under reduced motion.
fn drawer_panel(
    right: bool,
    width: f32,
    (ctx, ds): (&Ctx, &Ds),
    content: impl gpui::IntoElement,
) -> gpui::Div {
    let (open, fade) = if right {
        (ctx.t.right, ctx.t.right_fade)
    } else {
        (ctx.t.left, ctx.t.left_fade)
    };
    let el = div()
        .absolute()
        .top_0()
        .bottom_0()
        .w(px(width))
        .overflow_hidden()
        .bg(ds.color(Color::AdaptivePanelBg))
        .child(content);
    let el = if right { el.right_0() } else { el.left_0() };
    let timing = Timing::token(
        ds,
        DsDuration::AdaptivePanelDuration,
        Easing::AdaptivePanelEasing,
    );
    if ctx.reduced {
        let timing = Timing::token(
            ds,
            if open.target() == 1. {
                DsDuration::MotionFast
            } else {
                DsDuration::MotionExitFast
            },
            Easing::MotionEaseStandard,
        );
        fade.apply(
            el,
            &timing,
            &Props {
                opacity: Some((0., 1.)),
                ..Default::default()
            },
        )
    } else {
        open.apply(
            el,
            &timing,
            &Props {
                offset: Some((
                    gpui::point(px(if right { width } else { -width }), px(0.)),
                    gpui::point(px(0.), px(0.)),
                )),
                ..Default::default()
            },
        )
    }
}

/// The inspector drawer; at compact widths it covers the window under its panel titlebar.
fn inspector(
    shell: &mut AdaptiveShell,
    ctx: &Ctx,
    (width, compact): (f32, bool),
    ds: &Ds,
) -> Vec<AnyElement> {
    let t = &ctx.t;
    let timing = Timing::token(
        ds,
        DsDuration::AdaptivePanelDuration,
        Easing::AdaptivePanelEasing,
    );
    let fade = Timing::token(ds, DsDuration::MotionExitFast, Easing::MotionEaseStandard);
    if !ctx.inspector_open && !t.right.moving(&timing) && !t.right_fade.moving(&fade) {
        return Vec::new();
    }
    let Some(inspector) = shell.inspector.take() else {
        return Vec::new();
    };
    let top = if compact { ctx.safe_top } else { 0. };
    let body = div().size_full().pt(px(top)).child(inspector.content);
    let mut layers = vec![drawer_panel(true, width, (ctx, ds), body).into_any_element()];
    if let (true, Some(titlebar)) = (compact, inspector.titlebar) {
        layers.push(parts::panel_titlebar(
            titlebar,
            width,
            ds,
            ctx.inspector_open,
        ));
    }
    layers
}

/// The docked inspector: one card, `right` and `bottom` inset in the cards frame.
pub(super) fn docked_inspector(content: AnyElement, ctx: &Ctx, ds: &Ds) -> AnyElement {
    let t = &ctx.t;
    let reduced = ds.reduced_motion();
    let card_inset = f32::from(ds.len(Length::ShellCardInset));
    let (width, top, edge, bottom) = if ctx.cards {
        let hairline = f32::from(ds.len(Length::BorderHairline));
        (
            ctx.right_w - card_inset,
            ctx.safe_top + hairline,
            card_inset,
            card_inset,
        )
    } else {
        (ctx.right_w, ctx.inset, ctx.inset, ctx.inset)
    };
    let el = div()
        .absolute()
        .top(px(top))
        .bottom(px(bottom))
        .right(px(edge))
        .w(px(width))
        .overflow_hidden()
        .child(div().size_full().child(content));
    let el = if ctx.cards {
        // `--shell-card-shadow` is `none`.
        el.rounded(ds.len(Length::ShellCardRadius))
    } else {
        el
    };
    if reduced {
        let fade = Timing::token(
            ds,
            if ctx.inspector_open {
                DsDuration::MotionFast
            } else {
                DsDuration::MotionExitFast
            },
            Easing::MotionEaseStandard,
        );
        t.right_fade.apply(
            el,
            &fade,
            &Props {
                opacity: Some((0., 1.)),
                ..Default::default()
            },
        )
    } else {
        let timing = Timing::token(
            ds,
            DsDuration::AdaptivePanelDuration,
            Easing::AdaptivePanelEasing,
        );
        t.right.apply(
            el,
            &timing,
            &Props {
                offset: Some((gpui::point(px(width), px(0.)), gpui::point(px(0.), px(0.)))),
                ..Default::default()
            },
        )
    }
    .into_any_element()
}
