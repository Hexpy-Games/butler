//! AttachmentList.showcase.tsx: message attachments as a list, composer chips, message tiles,
//! thumbnail fit, composer tiles, blocked images, upload statuses and the empty list.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::attachment_list::{
    AttachmentItem, AttachmentList, ThumbnailFit, TileAlign, TileLayout, Upload, Variant,
};
use gpui::{AnyElement, App, ImageSource, IntoElement as _, Window};

use super::Story;
use super::media_frame::fixtures::{Kind, broken, picture_of, svg};
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Message attachments (list)",
            render: message_list,
        },
        Story {
            name: "Composer chips (removable)",
            render: chips,
        },
        Story {
            name: "Composer chips (image blocked)",
            render: chips_blocked,
        },
        Story {
            name: "Message tiles (wrap)",
            render: message_tiles,
        },
        Story {
            name: "Thumbnail fit (cover and contain)",
            render: fit,
        },
        Story {
            name: "Composer tiles (row, removable)",
            render: composer_row,
        },
        Story {
            name: "Composer tiles (image blocked)",
            render: row_blocked,
        },
        Story {
            name: "Upload statuses (tiles, start-aligned)",
            render: upload_tiles,
        },
        Story {
            name: "Upload statuses (list)",
            render: upload_list,
        },
        Story {
            name: "Empty",
            render: empty,
        },
    ]
}

struct Copy {
    preview: &'static str,
    empty: &'static str,
    notes: &'static str,
    shot: &'static str,
    no_images: &'static str,
    names: [&'static str; 6],
    file: &'static str,
    uploading: &'static str,
    too_large: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            preview: "Screenshot preview",
            empty: "No attachments",
            notes: "project-notes.md",
            shot: "settings-375.png",
            no_images: "Model doesn't accept images",
            names: [
                "lake.jpg",
                "lunch.jpg",
                "q2-revenue-report-final-reviewed.pdf",
                "contract-draft-v3.docx",
                "LICENSE",
                "broken-photo.jpg",
            ],
            file: "File",
            uploading: "Uploading 40%",
            too_large: "Over 10 MB",
        },
        Copy {
            preview: "스크린샷 미리보기",
            empty: "첨부 파일 없음",
            notes: "프로젝트-메모.md",
            shot: "설정-375.png",
            no_images: "이미지 미지원 모델",
            names: [
                "호수.jpg",
                "점심.jpg",
                "2026년_2분기_매출_보고서_최종.pdf",
                "계약서_초안_v3.docx",
                "LICENSE",
                "깨진_사진.jpg",
            ],
            file: "파일",
            uploading: "올리는 중 40%",
            too_large: "10MB 초과",
        },
    )
}

/// The 24px grey landscape the showcase embeds as its thumbnail.
pub(super) fn thumbnail() -> ImageSource {
    svg(
        24,
        24,
        "<rect width='24' height='24' fill='#e9eaec'/><path d='m4 17 4.5-5 3.5 3 2.5-3 5.5 6H4Z' fill='#71767d'/>",
    )
}

/// The 320x180 grey landscape of ArtifactPreview's showcase.
pub(super) fn thumbnail_wide() -> ImageSource {
    svg(
        320,
        180,
        "<rect width='320' height='180' fill='#e9eaec'/><path d='m40 140 70-70 50 45 35-30 85 55H40Z' fill='#71767d'/><circle cx='250' cy='50' r='18' fill='#9a9da2'/>",
    )
}

/// A sent message's mixed files: pictures, a PDF, a Word file, an unknown type, a broken picture.
fn tiles(lang: Lang) -> Vec<AttachmentItem> {
    let c = copy(lang);
    let n = c.names;
    vec![
        AttachmentItem::new("lake", n[0])
            .meta("2.4 MB")
            .thumbnail(picture_of(Kind::Place), ThumbnailFit::Cover),
        AttachmentItem::new("bowl", n[1])
            .meta("1.8 MB")
            .thumbnail(picture_of(Kind::Recipe), ThumbnailFit::Cover),
        AttachmentItem::new("report", n[2])
            .meta("1.1 MB")
            .extension("PDF"),
        AttachmentItem::new("draft", n[3])
            .meta("86 KB")
            .extension("DOCX"),
        AttachmentItem::new("license", n[4])
            .meta("4 KB")
            .extension(c.file),
        AttachmentItem::new("broken", n[5])
            .meta("900 KB")
            .extension("JPG")
            .thumbnail(broken(), ThumbnailFit::Cover),
    ]
}

/// A detail's attachments while editing: done, uploading and failed items.
fn uploads(lang: Lang) -> Vec<AttachmentItem> {
    let c = copy(lang);
    let all = tiles(lang);
    vec![
        all[0].clone(),
        all[1].clone().meta(c.uploading).upload(Upload::Uploading),
        all[2].clone().meta(c.uploading).upload(Upload::Uploading),
        all[3].clone().meta(c.too_large).upload(Upload::Failed),
        AttachmentItem::new("lake-2", c.names[0])
            .thumbnail(picture_of(Kind::Place), ThumbnailFit::Cover)
            .meta(c.too_large)
            .upload(Upload::Failed),
    ]
}

fn remove_label(lang: Lang) -> impl Fn(&str) -> String + 'static {
    move |name| lang.pick(format!("Remove {name}"), format!("{name} 제거"))
}

fn message_list(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    AttachmentList::new(
        "al-message",
        vec![
            AttachmentItem::new("a", c.shot)
                .meta("142 KB")
                .thumbnail(thumbnail(), ThumbnailFit::Cover),
            AttachmentItem::new("b", c.notes).meta("4 KB"),
        ],
    )
    .into_any_element()
}

fn chips(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    AttachmentList::new(
        "al-chips",
        vec![
            AttachmentItem::new(
                "image",
                "a-very-long-image-file-name-from-the-design-review.png",
            )
            .meta("142 KB")
            .icon(Icon::ImageIcon)
            .thumbnail(thumbnail(), ThumbnailFit::Cover),
            AttachmentItem::new("markdown", c.notes)
                .meta("4 KB")
                .icon(Icon::FileText),
            AttachmentItem::new("json", "large-export.json").meta("2 MB"),
            AttachmentItem::new("log", "runtime-output.log").meta("84 KB"),
        ],
    )
    .variant(Variant::Chips)
    .on_remove(|_, _, _| {})
    .remove_label(remove_label(lang))
    .into_any_element()
}

fn chips_blocked(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    AttachmentList::new(
        "al-chips-blocked",
        vec![
            AttachmentItem::new("image", c.shot)
                .meta("142 KB")
                .blocked(c.no_images)
                .thumbnail(thumbnail(), ThumbnailFit::Cover),
            AttachmentItem::new("markdown", c.notes)
                .meta("4 KB")
                .icon(Icon::FileText),
        ],
    )
    .variant(Variant::Chips)
    .on_remove(|_, _, _| {})
    .remove_label(remove_label(lang))
    .into_any_element()
}

fn message_tiles(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    AttachmentList::new("al-tiles", tiles(lang))
        .variant(Variant::Tiles)
        .tile_layout(TileLayout::Wrap)
        .on_open(|_, _, _| {})
        .into_any_element()
}

fn fit(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let preview = copy(lang).preview;
    let strip = || picture_of(Kind::Strip);
    AttachmentList::new(
        "al-fit",
        vec![
            AttachmentItem::new("default", preview).thumbnail(strip(), ThumbnailFit::Cover),
            AttachmentItem::new("cover", preview).thumbnail(strip(), ThumbnailFit::Cover),
            AttachmentItem::new("contain", preview).thumbnail(strip(), ThumbnailFit::Contain),
            AttachmentItem::new("tall", preview)
                .thumbnail(picture_of(Kind::Column), ThumbnailFit::Contain),
        ],
    )
    .variant(Variant::Tiles)
    .on_open(|_, _, _| {})
    .into_any_element()
}

fn composer_row(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let mut items = tiles(lang);
    items.extend(tiles(lang).into_iter().map(|item| {
        let mut again = item.clone();
        again = rename(again);
        again
    }));
    AttachmentList::new("al-row", items)
        .variant(Variant::Tiles)
        .tile_layout(TileLayout::Row)
        .on_open(|_, _, _| {})
        .on_remove(|_, _, _| {})
        .remove_label(remove_label(lang))
        .into_any_element()
}

/// The second copy of a tile set: a new id (`<id>-2`).
fn rename(item: AttachmentItem) -> AttachmentItem {
    item.with_id_suffix("-2")
}

fn row_blocked(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let all = tiles(lang);
    AttachmentList::new(
        "al-row-blocked",
        vec![all[0].clone().blocked(c.no_images), all[2].clone()],
    )
    .variant(Variant::Tiles)
    .tile_layout(TileLayout::Row)
    .on_open(|_, _, _| {})
    .on_remove(|_, _, _| {})
    .remove_label(remove_label(lang))
    .into_any_element()
}

fn upload_tiles(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    AttachmentList::new("al-uploads", uploads(lang))
        .variant(Variant::Tiles)
        .tile_layout(TileLayout::Wrap)
        .tile_align(TileAlign::Start)
        .on_open(|_, _, _| {})
        .on_remove(|_, _, _| {})
        .remove_label(remove_label(lang))
        .into_any_element()
}

fn upload_list(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let items = uploads(lang).into_iter().skip(1).take(3).collect();
    AttachmentList::new("al-upload-list", items).into_any_element()
}

fn empty(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    AttachmentList::new("al-empty", Vec::new())
        .empty_label(copy(lang).empty)
        .into_any_element()
}
