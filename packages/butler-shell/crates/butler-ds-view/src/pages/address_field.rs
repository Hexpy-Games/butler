//! AddressField.showcase.tsx: click to edit (Enter opens, Escape cancels), security glyphs, tags
//! and Butler pages, a long address and the disabled field. The state matrix is covered by the
//! live harness.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::address_field::{AddressField, AddressFieldLabels, AddressSecurity};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::tag::{Size as TagSize, Tag, Tone as TagTone};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, Entity, IntoElement as _, ParentElement as _, SharedString, Window};

use super::Story;
use crate::browser_demo::copy as browser_copy;
use crate::copy::Lang;

struct Words {
    labels: AddressFieldLabels,
    signed_in: &'static str,
    output: &'static str,
    library: &'static str,
    submitted: &'static str,
}

fn words(lang: Lang) -> Words {
    lang.pick(
        Words {
            labels: AddressFieldLabels::default(),
            signed_in: "Signed in",
            output: "Butler output",
            library: "Library",
            submitted: "Opens",
        },
        Words {
            labels: AddressFieldLabels {
                field: "주소".into(),
                placeholder: "검색 또는 URL 입력".into(),
                secure: "안전한 연결".into(),
                insecure: "주의 요함".into(),
                bookmark_add: "북마크 추가".into(),
                bookmarked: "북마크됨".into(),
            },
            signed_in: "로그인 사용",
            output: "버틀러 출력물",
            library: "서랍",
            submitted: "열기",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Click to edit (Enter opens, Escape cancels)",
            render: live,
        },
        Story {
            name: "Security, tags and Butler pages",
            render: security,
        },
        Story {
            name: "Long address truncates at the end",
            render: long,
        },
        Story {
            name: "Disabled (browser off)",
            render: |l, _, _| {
                AddressField::new("af-disabled")
                    .labels(words(l).labels)
                    .disabled()
                    .into_any_element()
            },
        },
    ]
}

/// The app container in miniature: click to edit, Enter opens, the star toggles.
fn live(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let w = words(lang);
    let shop = browser_copy(lang).url;
    let url: Entity<SharedString> = window.use_keyed_state("af-live-url", cx, |_, _| shop.into());
    let starred: Entity<bool> = window.use_keyed_state("af-live-star", cx, |_, _| false);
    let (current, bookmarked) = (url.read(cx).clone(), *starred.read(cx));
    let submit = url.clone();
    let fallback = current.clone();
    Stack::new()
        .gap(Space::Xs)
        .child(
            AddressField::new("af-live")
                .url(current.clone())
                .labels(w.labels)
                .on_submit(move |value, _, cx| {
                    let next: SharedString = if value.is_empty() {
                        fallback.clone()
                    } else {
                        value.into()
                    };
                    submit.update(cx, |url, _| *url = next);
                })
                .bookmarked(bookmarked)
                .on_toggle_bookmark(move |_, cx| starred.update(cx, |on, _| *on = !*on)),
        )
        .child(
            Typo::caption(format!("{}: {current}", w.submitted))
                .tone(Tone::Secondary)
                .tabular(),
        )
        .into_any_element()
}

fn security(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let w = words(lang);
    let ds = Ds::get(cx);
    let lock = Tag::new("af-signed-in", w.signed_in)
        .size(TagSize::Sm)
        .tone(TagTone::Accent)
        .icon(Icon::Lock);
    let output = Tag::new("af-output", w.output).size(TagSize::Sm);
    let library = icon(Icon::Library, IconSize::Md, ds);
    let field = |id: &'static str| AddressField::new(id).labels(w.labels.clone());
    Stack::new()
        .gap(Space::Sm)
        .child(
            field("af-billing")
                .url("https://console.example.net/billing/invoices")
                .on_submit(|_, _, _| {})
                .on_toggle_bookmark(|_, _| {})
                .bookmarked(true)
                .tag(lock),
        )
        .child(
            field("af-insecure")
                .url("http://intranet.example.com/login")
                .security(AddressSecurity::Insecure)
                .on_submit(|_, _, _| {})
                .on_toggle_bookmark(|_, _| {}),
        )
        .child(
            field("af-output-page")
                .url("https://output.butler.local/weekly-summary")
                .security(AddressSecurity::Internal)
                .on_submit(|_, _, _| {})
                .tag(output),
        )
        .child(
            field("af-library")
                .title(w.library)
                .icon(library)
                .security(AddressSecurity::Internal),
        )
        .child(field("af-empty").on_submit(|_, _, _| {}))
        .into_any_element()
}

fn long(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    AddressField::new("af-long")
        .url("https://docs.example.com/guides/getting-started/installation/configure-the-desktop-app?tab=macos#signing")
        .labels(words(lang).labels)
        .on_submit(|_, _, _| {})
        .on_toggle_bookmark(|_, _| {})
        .into_any_element()
}
