//! The peeked sidebar of the docked layout: a card over the workspace while the pointer is on
//! it, and the left-edge zone that asks for it.
use gpui::{
    AnyElement, App, InteractiveElement as _, IntoElement as _, ParentElement as _,
    StatefulInteractiveElement as _, Styled as _, div, px,
};

use super::{AdaptiveShell, Ctx, panel_rows, shell_tones};
use crate::tokens::{Color, Length, Shadow};
use crate::ui::blocks::adaptive_shell::peek::{CloseReason, SidebarPeek};
use crate::ui::blocks::scope::{self, Spec};
use crate::ui::context::Ds;
use crate::ui::convert;

/// The peeked sidebar: a card over the workspace while the pointer is on it.
pub(super) fn sidebar_peek(shell: &mut AdaptiveShell, ctx: &Ctx, cx: &mut App) -> Vec<AnyElement> {
    let ds = Ds::get(cx);
    let mut layers = Vec::new();
    let Some(peek) = shell.peek.clone() else {
        return Vec::new();
    };
    let sm = f32::from(ds.len(Length::SpaceSm));
    if !shell.left_open && !ctx.peeking {
        layers.push(peek_edge(&peek, sm));
    }
    if !ctx.peeking {
        return layers;
    }
    let Some(content) = shell.sidebar.take() else {
        return layers;
    };
    let travel = if ds.reduced_motion() {
        0.
    } else {
        f32::from(ds.len(Length::MotionDistanceMd))
    };
    let enter = ctx.t.peek;
    let tones = Spec {
        remap: [shell_tones(), panel_rows()].concat(),
        vars: Some(ctx.vars),
        ..Spec::default()
    };
    let shadow = convert::box_shadows(ds.tokens().shadow(Shadow::ShadowWindow), ds.tokens());
    let (enter_peek, leave_peek, out_peek) = (peek.clone(), peek.clone(), peek.clone());
    let card = div()
        .id((shell.id.clone(), "peek-card"))
        .debug_selector(|| "peek-card".to_owned())
        .absolute()
        .top(px(sm))
        .bottom(px(sm))
        .left(px(sm - travel * (1. - enter)))
        .w(px(ctx.left_w))
        .border(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::LineStrong))
        .rounded(ds.len(Length::RadiusPopover))
        .bg(ds.color(Color::AdaptivePanelBg))
        .shadow(shadow)
        .overflow_hidden()
        .opacity(enter)
        .on_hover(move |on, window, cx| {
            if *on {
                enter_peek.pointer_enter(cx);
            } else {
                leave_peek.pointer_leave(window, cx);
            }
        })
        .on_mouse_down_out(move |event, window, cx| {
            let _ = event;
            out_peek.close(CloseReason::PressOutside, window, cx);
        })
        .child(scope::scoped(tones, content));
    layers.push(card.into_any_element());
    layers
}

/// The left-edge hover zone of a collapsed sidebar.
fn peek_edge(peek: &SidebarPeek, width: f32) -> AnyElement {
    let peek = peek.clone();
    div()
        .id("peek-edge")
        .debug_selector(|| "peek-edge-zone".to_owned())
        .absolute()
        .top_0()
        .bottom_0()
        .left_0()
        .w(px(width))
        .on_hover(move |on, window, cx| {
            if *on {
                peek.show(window, cx);
            }
        })
        .into_any_element()
}
