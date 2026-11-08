//! SettingsNav.showcase.tsx: the grouped settings sidebar with one active section across
//! groups, the same on a white base and a tinted shell, and an untitled (default-titled) group.
use butler_ds::tokens::{Color, Length};
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::scope::{self, Spec};
use butler_ds::ui::blocks::settings_nav::{SettingsNav, SettingsNavItem};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Radius, Space, Stack};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Styled as _, Window, div};

use super::{Story, sub};
use crate::copy::Lang;

struct Copy {
    app: &'static str,
    general: &'static str,
    appearance: &'static str,
    privacy: &'static str,
    models: &'static str,
    mcp: &'static str,
    skills: &'static str,
    usage: &'static str,
    data: &'static str,
    butler: &'static str,
    update: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            app: "App",
            general: "General",
            appearance: "Appearance",
            privacy: "Privacy",
            models: "Models",
            mcp: "MCP servers",
            skills: "Skills",
            usage: "Usage",
            data: "Data",
            butler: "Butler",
            update: "1",
        },
        Copy {
            app: "앱",
            general: "일반",
            appearance: "화면",
            privacy: "개인정보",
            models: "모델",
            mcp: "MCP 서버",
            skills: "스킬",
            usage: "사용량",
            data: "데이터",
            butler: "버틀러",
            update: "1",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Grouped sections",
            render: grouped,
        },
        Story {
            name: "Fills: white base and tinted shell",
            render: fills,
        },
        Story {
            name: "Untitled group",
            render: untitled,
        },
    ]
}

/// `SettingsSidebar`: one SettingsNav per group, a single active section across groups. The
/// active id is held in the page's state (`useState("general")`); `salt` keeps copies apart.
fn sidebar(lang: Lang, salt: &'static str, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let active = window.use_keyed_state(sub(salt, "active"), cx, |_, _| "general");
    let now = *active.read(cx);
    let item = |id: &'static str, label: &'static str, glyph: Icon, badge: Option<&'static str>| {
        let active = active.clone();
        let mut item = SettingsNavItem::new(id, label)
            .glyph(glyph)
            .active(now == id)
            .on_select(move |_, _, cx| {
                active.update(cx, |value, cx| {
                    *value = id;
                    cx.notify();
                });
            });
        if let Some(badge) = badge {
            item = item.badge(badge);
        }
        item
    };
    Stack::new()
        .gap(Space::Lg)
        .child(
            SettingsNav::new(sub(salt, "app"))
                .title(c.app)
                .item(item("general", c.general, Icon::Settings, Some(c.update)))
                .item(item("appearance", c.appearance, Icon::Palette, None))
                .item(item("privacy", c.privacy, Icon::ShieldCheck, None)),
        )
        .child(
            SettingsNav::new(sub(salt, "butler"))
                .title(c.butler)
                .item(item("models", c.models, Icon::AiChip, None))
                .item(item("mcp", c.mcp, Icon::McpServer, None))
                .item(item("skills", c.skills, Icon::Sparkles, None))
                .item(item("usage", c.usage, Icon::Activity, None))
                .item(item("data", c.data, Icon::Database, None)),
        )
        .into_any_element()
}

fn grouped(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    sidebar(lang, "sn-grouped", window, cx)
}

/// `NavRowSurface`: a white base keeps the `--selection` shades; a tinted shell (a stand-in
/// for the macOS vibrancy) points rows at the `--mac-sidebar-*` fills.
fn surface(tinted: bool, content: AnyElement, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let base = ds.color(Color::ColorSurfaceBase);
    let bg = if tinted {
        butler_ds::ui::convert::mix(ds.color(Color::TextPrimary), base, 0.07) // DS: NavRowSurface.module.css:23
    } else {
        base
    };
    let frame = div()
        .p(ds.len(Length::SpaceSm))
        .rounded(Radius::Control.px(ds))
        .bg(bg);
    if tinted {
        let spec = Spec {
            nav_fills: Some((Color::MacSidebarHoverBg, Color::MacSidebarSelectedBg)), // DS: NavRowSurface.module.css:17-18
            ..Spec::default()
        };
        return scope::scoped(spec, frame.child(content)).into_any_element();
    }
    frame.child(content).into_any_element()
}

fn fills(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let white = sidebar(lang, "sn-white", window, cx);
    let tinted = sidebar(lang, "sn-tinted", window, cx);
    Stack::new()
        .gap(Space::Sm)
        .child(surface(false, white, cx))
        .child(surface(true, tinted, cx))
        .into_any_element()
}

fn untitled(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    SettingsNav::new("sn-untitled")
        .item(
            SettingsNavItem::new("general", c.general)
                .glyph(Icon::Settings)
                .active(true),
        )
        .item(SettingsNavItem::new("appearance", c.appearance).glyph(Icon::Palette))
        .into_any_element()
}
