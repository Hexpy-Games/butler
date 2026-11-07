//! Answer blocks: table, gallery, chart (`AnswerDataBlocks.tsx`).
use butler_ds::ui::blocks::markdown_content::MarkdownContent;
use butler_ds::ui::button::{self, Button, Variant};
use butler_ds::ui::chart::{
    Chart, ChartColor, ChartLegend, Kind, LegendItem, Series, Size as ChartSize, TooltipTitle,
};
use butler_ds::ui::collapsible::Collapsible;
use butler_ds::ui::context::Ds;
use butler_ds::ui::copy_button::CopyButton;
use butler_ds::ui::layout::{Basis, Space, Stack, WithItem as _};
use butler_ds::ui::media_frame::{Aspect, Fit, MediaFrame};
use butler_ds::ui::scroll::{Axis, ScrollArea};
use butler_ds::ui::typo::Typo;
use gpui::{
    AnyElement, App, ImageSource, InteractiveElement as _, IntoElement as _, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, div,
};

use super::frame::source_line;
use crate::ui::i18n::media::Media;
use crate::ui::shell::image_viewer::loader::{PictureId, picture};
use crate::ui::shell::image_viewer::{self, ViewerEntry};
use crate::ui::source::wire::{
    AnswerBlock, AnswerBlockChartKind, AnswerBlockChartSeriesItem, AnswerBlockGalleryItemsItem,
    AnswerCell, AnswerCellValue, AnswerMedia,
};

/// Rows shown before "show more" (`block.rows.slice(0, 10)`).
const PREVIEW_ROWS: usize = 10;

/// Renders one block of this family (table, gallery, chart).
pub(super) fn render(
    block: &AnswerBlock,
    path: &str,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let key = format!("answer-data-{path}");
    match block {
        AnswerBlock::Table { columns, rows, .. } => table(&key, columns, rows, window, cx),
        AnswerBlock::Gallery { media, items, .. } => gallery(&key, media.as_ref(), items, cx),
        AnswerBlock::Chart {
            kind,
            x,
            series,
            unit,
            checked,
            source,
            ..
        } => chart(
            &key,
            kind,
            x,
            series,
            unit.as_deref(),
            source.as_deref(),
            checked.as_deref(),
        ),
        _ => div().into_any_element(),
    }
}

/// A cell as text (`{cell}`): empty for null.
fn cell_text(cell: &AnswerCell) -> String {
    match cell {
        None => String::new(),
        Some(AnswerCellValue::Variant1(text)) => text.clone(),
        Some(AnswerCellValue::Variant2(number)) => number.to_string(),
    }
}

/// Text that Markdown shows literally: ASCII punctuation escaped, line breaks as spaces.
fn escape(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '\n' | '\r' => " ".to_owned(),
            c if c.is_ascii_punctuation() => format!("\\{c}"),
            c => c.to_string(),
        })
        .collect()
}

fn markdown_row(cells: impl Iterator<Item = String>) -> String {
    format!("| {} |\n", cells.collect::<Vec<_>>().join(" | "))
}

/// `MarkdownContent > MarkdownTable`: the columns as the header, the rows as the body.
fn markdown_table(id: String, columns: &[String], rows: &[Vec<AnswerCell>]) -> MarkdownContent {
    let mut source = markdown_row(columns.iter().map(|column| escape(column)));
    source.push_str(&markdown_row(columns.iter().map(|_| "---".to_owned())));
    for row in rows {
        source.push_str(&markdown_row((0..columns.len()).map(|column| {
            row.get(column)
                .map_or_else(String::new, |cell| escape(&cell_text(cell)))
        })));
    }
    MarkdownContent::new(SharedString::from(id), source)
}

/// `AnswerTable`: the first ten rows, the rest folded behind a toggle.
fn table(
    key: &str,
    columns: &[String],
    rows: &[Vec<AnswerCell>],
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let lang = Ds::get(cx).lang();
    let expanded =
        window.use_keyed_state(SharedString::from(format!("{key}-expanded")), cx, |_, _| {
            false
        });
    let open = *expanded.read(cx);
    let (head, tail) = rows.split_at(rows.len().min(PREVIEW_ROWS));
    let mut stack =
        Stack::new()
            .gap(Space::Sm)
            .child(markdown_table(format!("{key}-head"), columns, head));
    if !tail.is_empty() {
        let label = if open {
            Media::of(lang).show_less.to_owned()
        } else {
            Media::show_more_items(lang, tail.len())
        };
        stack = stack
            .child(
                Collapsible::new(SharedString::from(format!("{key}-tail")), open)
                    .child(markdown_table(format!("{key}-more"), columns, tail)),
            )
            .child(
                Button::new(SharedString::from(format!("{key}-toggle")))
                    .variant(Variant::Inline)
                    .text(label)
                    .on_click(move |_, _, cx| {
                        expanded.update(cx, |open, cx| {
                            *open = !*open;
                            cx.notify();
                        });
                    }),
            );
    }
    stack.into_any_element()
}

/// The gallery's frame shape (`aspect={block.media ?? "1:1"}`).
fn aspect(media: Option<&AnswerMedia>) -> Aspect {
    match media {
        Some(AnswerMedia::V45) => Aspect::FourFive,
        Some(AnswerMedia::V34) => Aspect::ThreeFour,
        Some(AnswerMedia::V169) => Aspect::SixteenNine,
        Some(AnswerMedia::V11 | AnswerMedia::Unknown) | None => Aspect::Square,
    }
}

/// One gallery picture: its frame, caption and copy button; a click opens the viewer.
fn gallery_item(
    key: &str,
    item: &AnswerBlockGalleryItemsItem,
    frame: Aspect,
    viewer: (&[ViewerEntry], usize),
    cx: &mut App,
) -> AnyElement {
    let copy = Media::get(cx);
    let mut media = MediaFrame::new(SharedString::from(format!("{key}-frame")))
        .aspect(frame)
        .fit(Fit::Cover)
        .placeholder();
    if let Some(image) = picture(&PictureId::Asset(item.img.clone()), cx) {
        media = media.src(ImageSource::Image(image));
    }
    let copied = item
        .caption
        .clone()
        .or_else(|| item.source.clone())
        .unwrap_or_else(|| item.img.clone());
    let (entries, at) = (viewer.0.to_vec(), viewer.1);
    let opened = div()
        .id(SharedString::from(format!("{key}-open")))
        .cursor_pointer()
        .on_click(move |_, _, cx| image_viewer::open(entries.clone(), at, cx))
        .child(media);
    let mut stack = Stack::new()
        .gap(Space::Xs)
        .basis(Basis::Sm)
        .shrink(false)
        .child(opened);
    if let Some(caption) = &item.caption {
        stack = stack.child(Typo::caption(caption.clone()));
    }
    stack
        .child(
            button::container(button::Size::IconSm).child(
                CopyButton::new(
                    SharedString::from(format!("{key}-copy")),
                    copy.copy,
                    copy.answer_copied,
                )
                .text(copied),
            ),
        )
        .into_any_element()
}

/// `AnswerGallery`: a sideways row of pictures.
fn gallery(
    key: &str,
    media: Option<&AnswerMedia>,
    items: &[AnswerBlockGalleryItemsItem],
    cx: &mut App,
) -> AnyElement {
    let frame = aspect(media);
    let entries: Vec<ViewerEntry> = items
        .iter()
        .map(|item| {
            let name = item.caption.clone().unwrap_or_default();
            let mut entry = ViewerEntry::new(PictureId::Asset(item.img.clone()), name);
            entry.caption = item.caption.clone();
            entry.source = item.source.clone();
            entry
        })
        .collect();
    let mut row = Stack::row().gap(Space::Sm);
    for (index, item) in items.iter().enumerate() {
        row = row.child(gallery_item(
            &format!("{key}-{index}"),
            item,
            frame,
            (entries.as_slice(), index),
            cx,
        ));
    }
    ScrollArea::new(SharedString::from(format!("{key}-scroll")))
        .orientation(Axis::X)
        .child(row)
        .into_any_element()
}

/// `AnswerChart`: the legend, the plot and the source line.
fn chart(
    key: &str,
    kind: &AnswerBlockChartKind,
    x: &[String],
    series: &[AnswerBlockChartSeriesItem],
    unit: Option<&str>,
    source: Option<&str>,
    checked: Option<&str>,
) -> AnyElement {
    let color = |index: usize| ChartColor::ALL[index % ChartColor::ALL.len()];
    let legend = ChartLegend::new(
        series
            .iter()
            .enumerate()
            .map(|(index, item)| LegendItem::new(item.name.clone(), color(index))),
    );
    let plot = Chart::new(
        SharedString::from(format!("{key}-plot")),
        if *kind == AnswerBlockChartKind::Bar {
            Kind::Bar
        } else {
            Kind::Line
        },
        x.iter().cloned(),
        series
            .iter()
            .enumerate()
            .map(|(index, item)| Series {
                name: item.name.clone().into(),
                color: color(index),
                values: item
                    .values
                    .iter()
                    .map(|value| value.unwrap_or(0.))
                    .collect(),
            })
            .collect(),
    )
    .unit(unit.unwrap_or_default().to_owned())
    .tooltip_title(TooltipTitle::FirstSeries)
    .size(ChartSize::Panel);
    let mut stack = Stack::new().gap(Space::Sm).child(legend).child(plot);
    stack = stack.children(source_line(
        SharedString::from(format!("{key}-source")),
        source,
        checked,
    ));
    stack.into_any_element()
}
