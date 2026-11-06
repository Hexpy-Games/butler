//! AdaptiveShell.showcase.tsx (+ fixtures `cardsStories`, `ShellFrameDemo`, `ShellContentDemo`,
//! BrowserPane `ConversationFrame`). The sidebar rows, the chat, the pane and the settings
//! screen are stand-ins for blocks of later batches; the window is the real shell.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::adaptive_shell::frame::{
    AutoCollapse, CHAT_WIDTH_DEFAULT, MIN_PAGE_WIDTH, sidebar_auto_collapses,
};
use butler_ds::ui::blocks::adaptive_shell::parts::ChromeFloatingToggle;
use butler_ds::ui::blocks::adaptive_shell::peek::SidebarPeek;
use butler_ds::ui::blocks::adaptive_shell::{AdaptiveShell, ShellFrame, ShellWindow, SplitConfig};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::typo::{Tone as TextTone, Typo};
use gpui::{
    AnyElement, App, ElementId, IntoElement as _, ParentElement as _, SharedString, Window,
};

use super::{Story, anchored};
use crate::copy::Lang;
use crate::standins_window::{demo, demo_sidebar, scaled_frame};

mod copy;
mod demo;
mod window;

use copy::copy;
use demo::shell_demo;
use window::{body, title_row};

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Sidebar, workspace and inspector",
            render: shell_demo,
        },
        Story {
            name: "Conversation frame: chat | browser pane (resizable)",
            render: |l, w, c| frame_story(l, Spec::chat_browser("flat-browser", 1440., 900.), w, c),
        },
        Story {
            name: "Pane open and close (live): one motion for pane, chat edge and title group",
            render: |l, w, c| {
                super::titlebar_shell::split_window(l, (false, true, "browser"), w, c)
            },
        },
        Story {
            name: "Sidebar peek",
            render: |l, w, c| {
                frame_story(
                    l,
                    Spec {
                        sidebar: Sidebar::Peek,
                        ..Spec::chat_browser("flat-peek", 1100., 800.)
                    },
                    w,
                    c,
                )
            },
        },
        Story {
            name: "Sidebar peek (live): edge hover, dismiss, host signal",
            render: live_peek,
        },
        Story {
            name: "Conversation frame with a wallpaper (contained to the chat)",
            render: |l, w, c| {
                frame_story(
                    l,
                    Spec {
                        wallpaper: true,
                        ..Spec::chat_browser("flat-wallpaper", 1440., 760.)
                    },
                    w,
                    c,
                )
            },
        },
        Story {
            name: "Auto-collapse below a 720px page",
            render: auto_collapse,
        },
        Story {
            name: "Cards frame: conversation (flat vs cards)",
            render: |l, w, c| flat_vs_cards(l, View::Chat, w, c),
        },
        Story {
            name: "Cards frame: conversation + browser (1440, and 1100 with the sidebar stepped aside)",
            render: browser_pair,
        },
        Story {
            name: "Cards frame: tall content stays inside the window",
            render: tall_content,
        },
        Story {
            name: "Cards frame: sidebar collapsed and peek",
            render: collapsed_and_peek,
        },
        Story {
            name: "Cards frame: settings (flat vs cards)",
            render: |l, w, c| flat_vs_cards(l, View::Settings, w, c),
        },
        Story {
            name: "Cards frame: standalone browser",
            render: |l, w, c| {
                frame_story(l, Spec::cards("cards-hub", View::Hub, 1440., 900.), w, c)
            },
        },
        Story {
            name: "Cards frame: wallpaper inside the card",
            render: |l, w, c| {
                frame_story(
                    l,
                    Spec {
                        wallpaper: true,
                        ..Spec::cards("cards-wallpaper", View::Chat, 1440., 900.)
                    },
                    w,
                    c,
                )
            },
        },
        Story {
            name: "Split right slot: short content fills the pane",
            render: |l, w, c| {
                frame_story(l, Spec::cards("cards-file", View::File, 1440., 900.), w, c)
            },
        },
    ]
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum View {
    Chat,
    Browser,
    Settings,
    Hub,
    File,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Sidebar {
    Open,
    Collapsed,
    Peek,
    LivePeek,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Content {
    Chat,
    Long,
    Empty,
}

/// One window of the showcases: the frame, the view in it, the sidebar state and the size it is
/// laid out at.
#[derive(Clone, Copy)]
pub(super) struct Spec {
    /// Where the window keeps its state: one per window of the page.
    pub(super) key: &'static str,
    pub(super) frame: ShellFrame,
    pub(super) view: View,
    pub(super) content: Content,
    pub(super) sidebar: Sidebar,
    pub(super) wallpaper: bool,
    pub(super) auto_collapse: bool,
    pub(super) size: (f32, f32),
}

impl Spec {
    /// `ConversationFrameDemo`: the flat frame, the chat beside the open browser pane.
    pub(super) fn chat_browser(key: &'static str, width: f32, height: f32) -> Self {
        Self {
            key,
            frame: ShellFrame::Flat,
            view: View::Browser,
            content: Content::Chat,
            sidebar: Sidebar::Open,
            wallpaper: false,
            auto_collapse: false,
            size: (width, height),
        }
    }

    /// `ShellFrameDemo` in the cards frame.
    pub(super) fn cards(key: &'static str, view: View, width: f32, height: f32) -> Self {
        Self {
            frame: ShellFrame::Cards,
            ..Self {
                view,
                ..Self::chat_browser(key, width, height)
            }
        }
    }
}

pub(super) fn glyph(id: &str, label: &'static str, which: Icon) -> IconButton {
    IconButton::new(SharedString::from(id.to_owned()), label).glyph(which)
}

/// A whole window: the shell with the demo sidebar and the spec's view, laid out at the spec's
/// size and scaled to the story (`ScaledFrame`).
fn frame_story(lang: Lang, spec: Spec, window: &mut Window, cx: &mut App) -> AnyElement {
    let key = spec.key;
    let d = demo(lang);
    let pane_state = window.use_keyed_state((ElementId::from(key), "pane"), cx, |_, _| true);
    let pane_open = matches!(spec.view, View::Browser | View::File) && *pane_state.read(cx);
    let width_state = window.use_keyed_state((ElementId::from(key), "width"), cx, |_, _| {
        CHAT_WIDTH_DEFAULT
    });
    let chat_width = *width_state.read(cx);
    let collapsed_state = window.use_keyed_state((ElementId::from(key), "auto"), cx, |_, _| false);
    let (shell_w, _) = spec.size;
    let auto = pane_open
        && spec.auto_collapse
        && sidebar_auto_collapses(AutoCollapse {
            shell_width: shell_w,
            sidebar_width: 304.,
            chat_width,
            collapsed: *collapsed_state.read(cx),
            min_page_width: MIN_PAGE_WIDTH,
        });
    if *collapsed_state.read(cx) != auto {
        collapsed_state.update(cx, |state, _| *state = auto);
    }
    let live = spec.sidebar == Sidebar::LivePeek;
    let left_open = spec.sidebar == Sidebar::Open && !auto;
    let peek = SidebarPeek::new((ElementId::from(key), "peek"), live, window, cx);
    let (win_w, win_h) = crate::app::logical_viewport(window, cx);
    let title = title_row(lang, &spec, pane_open, !left_open);
    let title = if pane_open {
        title.split_chat_width(Some(chat_width))
    } else {
        title
    };
    let split_body = body(
        lang,
        &spec,
        pane_open,
        chat_width,
        move |next, window, cx| {
            width_state.update(cx, |width, _| *width = next);
            window.refresh();
        },
        cx,
    );
    let mut shell = AdaptiveShell::new(key, ShellWindow::new(win_w, win_h))
        .frame(spec.frame)
        .left_open(left_open)
        .left_peek(spec.sidebar == Sidebar::Peek)
        .transparent_workspace(spec.wallpaper)
        .settings_active(spec.view == View::Settings)
        .panel_widths(304., 376.)
        .split(SplitConfig::new(pane_open).chat_width(chat_width))
        .sidebar(demo_sidebar("frame-sidebar", lang, !left_open, cx))
        .title(title)
        .workspace(split_body);
    if live {
        shell = shell.peek(peek);
    }
    if !left_open {
        shell = shell.chrome(ChromeFloatingToggle::new(
            "frame-chrome",
            glyph("frame-show-sidebar", d.show_sidebar, Icon::PanelLeft),
        ));
    }
    let _ = icon(Icon::PanelLeft, IconSize::Md, Ds::get(cx));
    scaled_frame(
        (ElementId::from(key), "frame"),
        spec.size,
        shell.into_any_element(),
        window,
        cx,
    )
}

fn live_peek(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let spec = Spec {
        sidebar: Sidebar::LivePeek,
        ..Spec::chat_browser("flat-live-peek", 1100., 700.)
    };
    let peek = SidebarPeek::new(
        (ElementId::from("flat-live-peek"), "peek"),
        true,
        window,
        cx,
    );
    let (shown, edge, outside) = (peek.open(cx), peek.clone(), peek.clone());
    let controls = Stack::row()
        .gap(Space::Sm)
        .cross(butler_ds::ui::layout::Cross::Center)
        .wrap(true)
        .child(anchored(
            Button::new("peek-edge")
                .size(Size::Sm)
                .variant(Variant::Outline)
                .text(c.peek_edge)
                .on_click(move |_, window, cx| edge.show(window, cx))
                .into_any_element(),
            "peek-edge-button",
        ))
        .child(
            Button::new("peek-native")
                .size(Size::Sm)
                .variant(Variant::Outline)
                .text(c.native_pointer)
                .on_click(move |_, window, cx| {
                    outside.show(window, cx);
                    outside.pointer_outside(window, cx);
                }),
        )
        .child(
            Typo::caption(if shown { c.peek_open } else { c.peek_closed })
                .tone(TextTone::Secondary),
        )
        .child(super::probe(format!("peek-{shown}")));
    Stack::new()
        .gap(Space::Sm)
        .child(controls)
        .child(frame_story(lang, spec, window, cx))
        .into_any_element()
}

fn auto_collapse(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let wide = Spec {
        auto_collapse: true,
        ..Spec::chat_browser("flat-auto-wide", 1440., 700.)
    };
    let narrow = Spec {
        auto_collapse: true,
        ..Spec::chat_browser("flat-auto-narrow", 1100., 700.)
    };
    Stack::new()
        .gap(Space::Md)
        .child(frame_story(lang, wide, window, cx))
        .child(frame_story(lang, narrow, window, cx))
        .into_any_element()
}

/// `FlatVsCards`: the same window in both frames.
fn flat_vs_cards(lang: Lang, view: View, window: &mut Window, cx: &mut App) -> AnyElement {
    let (flat_key, cards_key) = if view == View::Settings {
        ("flat-settings", "cards-settings")
    } else {
        ("flat-chat", "cards-chat")
    };
    let flat = Spec {
        view,
        ..Spec::chat_browser(flat_key, 1440., 900.)
    };
    let cards = Spec {
        frame: ShellFrame::Cards,
        key: cards_key,
        ..flat
    };
    let label = |text: &'static str| Typo::caption(text).tone(TextTone::Secondary);
    Stack::new()
        .gap(Space::Md)
        .child(label("frame=\"flat\""))
        .child(frame_story(lang, flat, window, cx))
        .child(label("frame=\"cards\""))
        .child(frame_story(lang, cards, window, cx))
        .into_any_element()
}

fn browser_pair(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let one = Spec::cards("cards-browser-wide", View::Browser, 1440., 900.);
    let two = Spec {
        sidebar: Sidebar::Collapsed,
        ..Spec::cards("cards-browser-narrow", View::Browser, 1100., 800.)
    };
    Stack::new()
        .gap(Space::Md)
        .child(frame_story(lang, one, window, cx))
        .child(frame_story(lang, two, window, cx))
        .into_any_element()
}

fn tall_content(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let long = Spec {
        content: Content::Long,
        ..Spec::cards("cards-long", View::Chat, 1440., 900.)
    };
    let empty = Spec {
        content: Content::Empty,
        ..Spec::cards("cards-empty", View::Chat, 1100., 800.)
    };
    Stack::new()
        .gap(Space::Md)
        .child(frame_story(lang, long, window, cx))
        .child(frame_story(lang, empty, window, cx))
        .into_any_element()
}

fn collapsed_and_peek(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let collapsed = Spec {
        sidebar: Sidebar::Collapsed,
        ..Spec::cards("cards-collapsed", View::Chat, 1440., 900.)
    };
    let peek = Spec {
        sidebar: Sidebar::Peek,
        ..Spec::cards("cards-peek", View::Browser, 1100., 800.)
    };
    Stack::new()
        .gap(Space::Md)
        .child(frame_story(lang, collapsed, window, cx))
        .child(frame_story(lang, peek, window, cx))
        .into_any_element()
}
