//! DoneIconButton.showcase.tsx.
use std::time::Duration;

use butler_ds::ui::Icon;
use butler_ds::ui::context::Ds;
use butler_ds::ui::copy_button::CopyButton;
use butler_ds::ui::done_icon_button::DoneIconButton;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Inline, Space};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    save: &'static str,
    saved: &'static str,
    duplicate: &'static str,
    copied: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            save: "Save to library",
            saved: "Saved to library",
            duplicate: "Copy",
            copied: "Copied",
        },
        Copy {
            save: "서랍에 저장",
            saved: "서랍에 저장했어요",
            duplicate: "복사",
            copied: "복사했어요",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Save and confirm",
            render: confirm,
        },
        Story {
            name: "Done state",
            render: done,
        },
        Story {
            name: "Failed action: no check",
            render: failed,
        },
    ]
}

/// A stand-in for the container's save: it settles after a short round trip.
fn save(
    failing: bool,
) -> impl Fn(&mut Window, &mut App) -> gpui::Task<Result<(), gpui::SharedString>> {
    move |window, cx| {
        window.spawn(cx, async move |cx| {
            cx.background_executor()
                .timer(Duration::from_millis(300))
                .await;
            if failing {
                Err("save_failed".into())
            } else {
                Ok(())
            }
        })
    }
}

fn confirm(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    Inline::new()
        .gap(Space::Sm)
        .child(
            DoneIconButton::new("done-save", c.save, c.saved)
                .icon(icon(Icon::Library, IconSize::Sm, Ds::get(cx)))
                .on_action(save(false)),
        )
        .child(CopyButton::new("done-copy", c.duplicate, c.copied).text("Butler copied this item."))
        .into_any_element()
}

fn done(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    DoneIconButton::new("done-state", c.save, c.saved)
        .icon(icon(Icon::Library, IconSize::Sm, Ds::get(cx)))
        .done(true)
        .into_any_element()
}

fn failed(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    DoneIconButton::new("done-failed", c.save, c.saved)
        .icon(icon(Icon::Library, IconSize::Sm, Ds::get(cx)))
        .on_action(save(true))
        .on_error(|_, _| {})
        .into_any_element()
}
