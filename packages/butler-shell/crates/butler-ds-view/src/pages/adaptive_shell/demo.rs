//! The first story: the compact shell with a sidebar, a workspace and an inspector.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::adaptive_shell::grip::{HintSide, ResizeHandle};
use butler_ds::ui::blocks::adaptive_shell::parts::ChromeFloatingToggle;
use butler_ds::ui::blocks::adaptive_shell::{AdaptiveShell, HandleSide, ShellWindow};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Box, Space, Stack};
use butler_ds::ui::typo::{Tone as TextTone, Typo};
use gpui::{
    AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Styled as _, Window, div,
    px,
};

use super::anchored;
use crate::copy::Lang;

use super::copy::copy;

fn glyph(id: &str, label: &'static str, which: Icon) -> IconButton {
    IconButton::new(SharedString::from(id.to_owned()), label).glyph(which)
}

/// `AdaptivePanelTitlebar`'s close control and the inspector body of the compact demo.
pub(super) fn shell_demo(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let panel = window.use_keyed_state("adaptive-demo-panel", cx, |_, _| Some("left"));
    let current = *panel.read(cx);
    let set = |value: Option<&'static str>| {
        let panel = panel.clone();
        move |_: &mut Window, cx: &mut App| {
            panel.update(cx, |panel, cx| {
                *panel = value;
                cx.notify();
            });
        }
    };
    let (win_w, win_h) = crate::app::logical_viewport(window, cx);
    let open_nav = set(if current == Some("left") {
        None
    } else {
        Some("left")
    });
    let toggle = glyph("adaptive-toggle", c.open_nav, Icon::PanelLeft).on_click({
        let open_nav = open_nav.clone();
        move |_, window, cx| open_nav(window, cx)
    });
    let sidebar = Box::new().padding(Space::Md).child(
        Stack::new()
            .gap(Space::Sm)
            .child(Typo::panel_title(c.navigation))
            .child(
                Button::new("adaptive-nav-close")
                    .size(Size::Sm)
                    .variant(Variant::Outline)
                    .text(c.close)
                    .on_click({
                        let close = set(None);
                        move |_, window, cx| close(window, cx)
                    }),
            ),
    );
    let workspace = Box::new().padding(Space::Md).child(
        Stack::new()
            .gap(Space::Sm)
            .child(Typo::app_title(c.workspace))
            .child(Typo::caption(c.hint).tone(TextTone::Secondary))
            .child(
                Stack::row()
                    .gap(Space::Sm)
                    .wrap(true)
                    .child(anchored(
                        Button::new("adaptive-open-nav")
                            .size(Size::Sm)
                            .text(c.open_nav)
                            .on_click({
                                let open = set(Some("left"));
                                move |_, window, cx| open(window, cx)
                            })
                            .into_any_element(),
                        "adaptive-open-nav",
                    ))
                    .child(anchored(
                        Button::new("adaptive-open-inspector")
                            .size(Size::Sm)
                            .variant(Variant::Outline)
                            .text(c.open_inspector)
                            .on_click({
                                let open = set(Some("right"));
                                move |_, window, cx| open(window, cx)
                            })
                            .into_any_element(),
                        "adaptive-open-inspector",
                    )),
            ),
    );
    let close_inspector = glyph("adaptive-inspector-close", c.close, Icon::PanelRightClose)
        .selected()
        .on_click({
            let close = set(None);
            move |_, window, cx| close(window, cx)
        });
    let mut shell = AdaptiveShell::new("adaptive-demo", ShellWindow::new(win_w, win_h))
        .compact_sidebar_full_width(true)
        .left_open(current == Some("left"))
        .right_open(current == Some("right"))
        .panel_widths(220., 260.)
        .chrome(ChromeFloatingToggle::new(
            "adaptive-chrome",
            anchored(toggle.into_any_element(), "adaptive-toggle"),
        ))
        .sidebar(sidebar)
        .workspace(workspace)
        .inspector(
            Box::new()
                .padding(Space::Md)
                .child(Typo::panel_title(c.inspector)),
        )
        .inspector_titlebar(close_inspector)
        .scrim(c.scrim, {
            let close = set(None);
            move |window, cx| close(window, cx)
        });
    if current == Some("left") {
        shell = shell.resize_handle(
            HandleSide::Left,
            ResizeHandle::new("adaptive-resize", HintSide::End)
                .label(c.resize)
                .hint(c.drag)
                .on_drag(|_, _, _| {}),
        );
    }
    div().h(px(420.)).child(shell).into_any_element() // DS: AdaptiveShell.showcase.tsx:46
}
