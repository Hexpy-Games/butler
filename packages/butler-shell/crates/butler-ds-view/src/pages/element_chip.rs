//! ElementChip.showcase.tsx: element chips in the composer's attachment row, in a sent message,
//! with wide, tall and missing crops, and a long title at mobile width. The crops are flat
//! illustrations in place of the browser fixtures' page captures.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::attachment_list::{
    AttachmentItem, AttachmentList, ThumbnailFit, Variant,
};
use butler_ds::ui::blocks::element_chip::ElementChip;
use butler_ds::ui::layout::{Cross, Space, Stack};
use gpui::{AnyElement, App, ImageSource, IntoElement as _, ParentElement as _, Window};

use super::Story;
use super::media_frame::fixtures::{Kind, picture_of, svg};
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "In the composer (AttachmentList chips)",
            render: composer,
        },
        Story {
            name: "In a sent message (read-only)",
            render: sent,
        },
        Story {
            name: "Wide, tall and missing crops",
            render: crops,
        },
        Story {
            name: "Long title at mobile width",
            render: long_title,
        },
    ]
}

struct Copy {
    chair: &'static str,
    air: &'static str,
    long: &'static str,
    remove: &'static str,
    notes: &'static str,
    heading: &'static str,
    line: &'static str,
    column: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            chair: "Mesh Office Chair M2",
            air: "Air Mesh Chair",
            long: "Ergonomic mesh office chair with adjustable lumbar support",
            remove: "Remove",
            notes: "comparison-notes.md",
            heading: "Office chairs",
            line: "128 items · lowest price",
            column: "Filters",
        },
        Copy {
            chair: "메쉬 사무용 의자 M2",
            air: "에어 메쉬 체어",
            long: "요추 지지대 높이를 조절할 수 있는 인체공학 메쉬 사무용 의자",
            remove: "삭제",
            notes: "비교-메모.md",
            heading: "사무용 의자",
            line: "128개 상품 · 낮은 가격순",
            column: "필터",
        },
    )
}

const SITE: &str = "shop.example.com";

/// A page crop: a wide strip, a tall column, or a product block.
fn crop(width: u32, height: u32, tint: &str) -> ImageSource {
    svg(
        width,
        height,
        &format!(
            "<rect width='{width}' height='{height}' fill='#ffffff'/><rect x='6' y='6' width='{}' height='{}' rx='3' fill='{tint}'/>",
            width.saturating_sub(12),
            (height / 3).max(6)
        ),
    )
}

fn items(lang: Lang) -> Vec<AttachmentItem> {
    let c = copy(lang);
    vec![
        AttachmentItem::new("e1", c.chair)
            .element(SITE)
            .thumbnail(picture_of(Kind::Product), ThumbnailFit::Cover),
        AttachmentItem::new("e2", c.air)
            .element(SITE)
            .thumbnail(picture_of(Kind::Place), ThumbnailFit::Cover),
        AttachmentItem::new("f1", c.notes)
            .meta("4 KB")
            .icon(Icon::FileText),
    ]
}

fn composer(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let removed = window.use_keyed_state("ec-removed", cx, |_, _| Vec::<String>::new());
    let gone = removed.read(cx).clone();
    let list: Vec<AttachmentItem> = items(lang)
        .into_iter()
        .filter(|item| !gone.iter().any(|id| id == item_id(item)))
        .collect();
    AttachmentList::new("ec-composer", list)
        .variant(Variant::Chips)
        .remove_label(move |_| copy(lang).remove.to_owned())
        .on_remove(move |id, _, cx| {
            removed.update(cx, |removed, cx| {
                removed.push(id.to_string());
                cx.notify();
            });
        })
        .into_any_element()
}

fn item_id(item: &AttachmentItem) -> &str {
    item.id()
}

fn sent(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    AttachmentList::new("ec-sent", items(lang)).into_any_element()
}

fn crops(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Stack::new()
        .gap(Space::Sm)
        .cross(Cross::Start)
        .child(
            ElementChip::new("ec-heading", c.heading, SITE)
                .src(crop(360, 40, "#c9cdd2"))
                .on_remove(c.remove, |_, _, _| {}),
        )
        .child(
            ElementChip::new("ec-line", c.line, SITE)
                .src(crop(300, 24, "#d6dae0"))
                .on_remove(c.remove, |_, _, _| {}),
        )
        .child(ElementChip::new("ec-column", c.column, SITE).src(crop(60, 220, "#c9cdd2")))
        .child(ElementChip::new("ec-missing", c.chair, SITE))
        .into_any_element()
}

fn long_title(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Stack::new()
        .gap(Space::Sm)
        .cross(Cross::Start)
        .child(
            ElementChip::new("ec-long-a", c.long, SITE)
                .src(picture_of(Kind::Product))
                .on_remove(c.remove, |_, _, _| {}),
        )
        .child(ElementChip::new("ec-long-b", c.long, SITE).src(picture_of(Kind::Place)))
        .into_any_element()
}
