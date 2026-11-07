//! Answer blocks: table, gallery, chart (`AnswerDataBlocks.tsx`).
use std::hash::{DefaultHasher, Hash as _, Hasher as _};
use std::sync::Arc;

use butler_ds::ui::blocks::markdown_content::MarkdownContent;
use butler_ds::ui::button::{self, Button, Variant};
use butler_ds::ui::chart::{
    Chart, ChartColor, ChartLegend, Kind, LegendItem, Series, Size as ChartSize, TooltipTitle,
};
use butler_ds::ui::collapsible::Collapsible;
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::copy_button::CopyButton;
use butler_ds::ui::layout::{Basis, Space, Stack, WithItem as _};
use butler_ds::ui::media_frame::{Aspect, Fit, MediaFrame};
use butler_ds::ui::scroll::{Axis, ScrollArea};
use butler_ds::ui::typo::{Tone, Typo};
use butler_shell_client::ShellClient;
use futures::channel::oneshot;
use gpui::{
    AnyElement, App, Image, ImageFormat, ImageSource, IntoElement as _, ParentElement as _,
    SharedString, Window, div,
};

use crate::ui::chat::TranscriptCtx;
use crate::ui::source::wire::{
    AnswerBlock, AnswerBlockChartKind, AnswerBlockChartSeriesItem, AnswerBlockGalleryItemsItem,
    AnswerCell, AnswerCellValue, AnswerMedia,
};

/// Rows shown before "show more" (`block.rows.slice(0, 10)`).
const PREVIEW_ROWS: usize = 10;

/// `appCopy.conversation.answerBlocks` strings the data blocks use.
struct Words {
    show_less: &'static str,
    copy: &'static str,
    copied: &'static str,
}

const KO: Words = Words {
    show_less: "접기",
    copy: "복사",
    copied: "복사했어요",
};

const EN: Words = Words {
    show_less: "Show less",
    copy: "Copy",
    copied: "Copied",
};

/// `answerBlocks.showMoreItems`
fn show_more_items(lang: Lang, count: usize) -> String {
    match lang {
        Lang::Ko => format!("{count}개 더 보기"),
        Lang::En => format!("Show {count} more"),
    }
}

/// Renders one block of this family (table, gallery, chart).
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
pub(super) fn render(
    block: &AnswerBlock,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let key = block_key(block);
    match block {
        AnswerBlock::Table { columns, rows, .. } => table(&key, columns, rows, window, cx),
        AnswerBlock::Gallery { media, items, .. } => {
            gallery(&key, media.as_ref(), items, t, window, cx)
        }
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

/// A stable element key for the block: its id, else a hash of its content.
fn block_key(block: &AnswerBlock) -> String {
    let mut hasher = DefaultHasher::new();
    format!("{block:?}").hash(&mut hasher);
    format!("answer-data-{:x}", hasher.finish())
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
    let words = if lang == Lang::Ko { &KO } else { &EN };
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
            words.show_less.to_owned()
        } else {
            show_more_items(lang, tail.len())
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

/// The picture format a response's content type names.
fn image_format(content_type: &str) -> Option<ImageFormat> {
    match content_type.split(';').next()?.trim() {
        "image/png" => Some(ImageFormat::Png),
        "image/jpeg" | "image/jpg" => Some(ImageFormat::Jpeg),
        "image/webp" => Some(ImageFormat::Webp),
        "image/gif" => Some(ImageFormat::Gif),
        "image/svg+xml" => Some(ImageFormat::Svg),
        "image/bmp" => Some(ImageFormat::Bmp),
        "image/tiff" => Some(ImageFormat::Tiff),
        _ => None,
    }
}

/// Downloads `/message-assets/{id}` on its own runtime (the client needs tokio's reactor,
/// gpui's executor has none).
async fn fetch_asset(client: ShellClient, id: String) -> Option<Arc<Image>> {
    let (send, receive) = oneshot::channel();
    std::thread::spawn(move || {
        let download = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .ok()
            .and_then(|runtime| {
                runtime
                    .block_on(client.download_message_asset(&id, false))
                    .ok()
            });
        let _ = send.send(download);
    });
    let download = receive.await.ok().flatten()?;
    let format = image_format(download.content_type.as_deref()?)?;
    Some(Arc::new(Image::from_bytes(format, download.bytes)))
}

/// Where a gallery picture is.
#[derive(Default)]
enum Asset {
    #[default]
    Idle,
    Loading,
    Ready(Arc<Image>),
    Failed,
}

/// The picture of the collected image `img`: fetched once, then kept.
fn asset_image(
    img: &str,
    client: Option<&ShellClient>,
    window: &mut Window,
    cx: &mut App,
) -> Option<Arc<Image>> {
    let state = window.use_keyed_state(
        SharedString::from(format!("answer-asset-{img}")),
        cx,
        |_, _| Asset::Idle,
    );
    match state.read(cx) {
        Asset::Ready(image) => return Some(image.clone()),
        Asset::Loading | Asset::Failed => return None,
        Asset::Idle => {}
    }
    let client = client?.clone();
    state.update(cx, |asset, _| *asset = Asset::Loading);
    let id = img.to_owned();
    cx.spawn(async move |cx| {
        let image = fetch_asset(client, id).await;
        let _ = state.update(cx, |asset, cx| {
            *asset = image.map_or(Asset::Failed, Asset::Ready);
            cx.notify();
        });
    })
    .detach();
    None
}

/// One gallery picture: its frame, caption and copy button.
fn gallery_item(
    key: &str,
    item: &AnswerBlockGalleryItemsItem,
    frame: Aspect,
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let words = if Ds::get(cx).lang() == Lang::Ko {
        &KO
    } else {
        &EN
    };
    let picture = asset_image(&item.img, t.client.as_ref(), window, cx);
    let mut media = MediaFrame::new(SharedString::from(format!("{key}-frame")))
        .aspect(frame)
        .fit(Fit::Cover)
        .placeholder();
    if let Some(image) = picture {
        media = media.src(ImageSource::Image(image));
    }
    let copied = item
        .caption
        .clone()
        .or_else(|| item.source.clone())
        .unwrap_or_else(|| item.img.clone());
    let mut stack = Stack::new()
        .gap(Space::Xs)
        .basis(Basis::Sm)
        .shrink(false)
        .child(media);
    if let Some(caption) = &item.caption {
        stack = stack.child(Typo::caption(caption.clone()));
    }
    stack
        .child(
            button::container(button::Size::IconSm).child(
                CopyButton::new(
                    SharedString::from(format!("{key}-copy")),
                    words.copy,
                    words.copied,
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
    t: &TranscriptCtx,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let frame = aspect(media);
    let mut row = Stack::row().gap(Space::Sm);
    for (index, item) in items.iter().enumerate() {
        row = row.child(gallery_item(
            &format!("{key}-{index}"),
            item,
            frame,
            t,
            window,
            cx,
        ));
    }
    ScrollArea::new(SharedString::from(format!("{key}-scroll")))
        .orientation(Axis::X)
        .child(row)
        .into_any_element()
}

/// The source line's text: the site and when it was read (`AnswerSourceLine`).
fn source_text(source: &str, checked: Option<&str>) -> Option<String> {
    let url = url::Url::parse(source).ok()?;
    let site = url.host_str()?.trim_start_matches("www.").to_owned();
    let when = checked.and_then(checked_label);
    Some(
        [Some(site), when]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" · "),
    )
}

/// `checkedLabel`: today's time, else a short date (UTC; the shell has no local zone).
fn checked_label(checked: &str) -> Option<String> {
    let date = chrono::DateTime::parse_from_rfc3339(checked)
        .ok()?
        .with_timezone(&chrono::Utc);
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    let now = chrono::DateTime::from_timestamp(i64::try_from(seconds).ok()?, 0)?;
    let format = if date.date_naive() == now.date_naive() {
        "%H:%M"
    } else {
        "%Y-%m-%d"
    };
    Some(date.format(format).to_string())
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
    if let Some(text) = source.and_then(|source| source_text(source, checked)) {
        stack = stack.child(Typo::caption(text).tone(Tone::Tertiary));
    }
    stack.into_any_element()
}
