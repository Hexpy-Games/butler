//! GlyphToggle.showcase.tsx.
use butler_ds::ui::Icon;
use butler_ds::ui::context::Ds;
use butler_ds::ui::glyph_toggle::GlyphToggle;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Pin toggle over a row glyph",
            render: |lang, window, cx| row("glyph-toggle", false, lang, window, cx),
        },
        Story {
            name: "Pinned",
            render: |lang, window, cx| row("glyph-pinned", true, lang, window, cx),
        },
    ]
}

fn row(
    id: &'static str,
    initial: bool,
    lang: Lang,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let pinned = window.use_keyed_state(id, cx, move |_, _| initial);
    let on = *pinned.read(cx);
    let (title, pin, unpin) = lang.pick(
        ("Butler site", "Pin", "Unpin"),
        ("버틀러 사이트", "고정", "고정 해제"),
    );
    let ds = Ds::get(cx);
    // The React pinned glyph is Sparkles filled with currentColor; the icon set has the
    // outlined Sparkles only.
    Stack::row()
        .cross(Cross::Center)
        .gap(Space::Sm)
        .child(
            GlyphToggle::new(id, format!("{title} {}", if on { unpin } else { pin }), on)
                .glyph(icon(Icon::Briefcase, IconSize::Md, ds))
                .toggle_glyph(icon(Icon::Sparkles, IconSize::Md, ds))
                .on_click(move |_, _, cx| {
                    pinned.update(cx, |on, cx| {
                        *on = !*on;
                        cx.notify();
                    });
                }),
        )
        .child(Typo::text(title).truncate())
        .into_any_element()
}
