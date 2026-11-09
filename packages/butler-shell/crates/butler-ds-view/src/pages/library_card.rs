//! LibraryCard.showcase.tsx: tags, selection, rename and dragging, the 3 and 4 column grids, one
//! phone column, crops of every shape, and block scraps. The pictures are the MediaFrame page's
//! flat fixtures.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::library_card::{LibraryCard, LibraryCardEditing, LibraryCardMedia};
use butler_ds::ui::blocks::metric_card::{MetricCard, MetricGrid, Trend};
use butler_ds::ui::blocks::overflow_action_menu::{OverflowActionMenu, OverflowItem};
use butler_ds::ui::blocks::status_checklist::{ChecklistItem, StatusChecklist};
use butler_ds::ui::layout::{Columns, Grid, Preset, Responsive, Space};
use gpui::{AnyElement, App, IntoElement as _, Window};

use super::Story;
use super::media_frame::fixtures::{Kind, picture_of};
use crate::copy::Lang;

struct Copy {
    element: &'static str,
    view: &'static str,
    doc: &'static str,
    block: &'static str,
    spend: &'static str,
    income: &'static str,
    steps: [&'static str; 3],
    block_titles: [&'static str; 2],
    more: &'static str,
    attach: &'static str,
    open: &'static str,
    remove: &'static str,
    tags: [&'static str; 4],
    select: &'static str,
    name: &'static str,
    crops: [&'static str; 5],
    /// Title, meta and (for the first) the quoted words.
    items: [(&'static str, &'static str); 8],
    quote: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(english(), korean())
}

fn english() -> Copy {
    Copy {
        element: "Element",
        view: "View",
        doc: "Document",
        block: "Block",
        spend: "Spending",
        income: "Income",
        steps: ["Book the venue", "Send invitations", "Order the cake"],
        block_titles: ["This month", "Party checklist"],
        more: "More",
        attach: "Attach to chat",
        open: "Open source",
        remove: "Delete",
        tags: ["chairs", "office", "under 150k", "reviews"],
        select: "Select",
        name: "Name",
        crops: [
            "Office chairs (heading)",
            "128 items (a line)",
            "Filters (a column)",
            "Getting started (a view)",
            "Browser fixture (page title)",
        ],
        items: [
            ("Lumbar height comes first", "desk.example.kr · Today"),
            (
                "Mesh Office Chair M2 · ₩129,000",
                "shop.example.com · Today",
            ),
            ("Air Mesh Chair · ₩139,000", "shop.example.com · Today"),
            (
                "Choosing a chair that protects your back",
                "desk.example.kr · Yesterday",
            ),
            ("Cloudnest invoices", "console.example.net · 10/6"),
            ("Weekly summary", "Butler output · 10/5"),
            ("Getting started", "docs.example.com · 10/3"),
            ("Q3 report", "Files · 10/2"),
        ],
        quote: "“Adjust the lumbar height before the backrest angle.”",
    }
}

fn korean() -> Copy {
    Copy {
        element: "요소",
        view: "화면",
        doc: "문서",
        block: "블록",
        spend: "지출",
        income: "수입",
        steps: ["장소 예약", "초대장 보내기", "케이크 주문"],
        block_titles: ["이번 달", "파티 준비"],
        more: "더 보기",
        attach: "대화에 첨부",
        open: "원본 열기",
        remove: "삭제",
        tags: ["의자", "사무실", "15만원 이하", "후기"],
        select: "선택",
        name: "이름",
        crops: [
            "사무용 의자 (제목)",
            "128개 상품 (한 줄)",
            "필터 (세로 칸)",
            "Getting started (화면)",
            "Browser fixture (페이지 제목)",
        ],
        items: [
            ("요추 지지대 높이 조절이 먼저", "desk.example.kr · 오늘"),
            ("메쉬 사무용 의자 M2 · 129,000원", "shop.example.com · 오늘"),
            ("에어 메쉬 체어 · 139,000원", "shop.example.com · 오늘"),
            (
                "허리를 지키는 사무용 의자 고르는 법",
                "desk.example.kr · 어제",
            ),
            ("Cloudnest 청구서 목록", "console.example.net · 10/6"),
            ("이번 주 요약", "버틀러 출력물 · 10/5"),
            ("Getting started", "docs.example.com · 10/3"),
            ("3분기 보고서", "파일 · 10/2"),
        ],
        quote: "“등받이 각도보다 요추 지지대의 높이 조절이 먼저입니다.”",
    }
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Organizing: tags, selection, rename, dragging",
            render: organizing,
        },
        Story {
            name: "3-column grid",
            render: |lang, _, _| grid(lang, "lc-grid-3", 3, 6),
        },
        Story {
            name: "4-column grid",
            render: |lang, _, _| grid(lang, "lc-grid-4", 4, 8),
        },
        Story {
            name: "Phone: one column",
            render: |lang, _, _| grid(lang, "lc-grid-1", 1, 3),
        },
        Story {
            name: "Typical crops span the slot; strips and columns sit inset",
            render: crops,
        },
        Story {
            name: "Block scraps",
            render: blocks,
        },
    ]
}

fn columns(base: u8, compact: u8) -> Columns {
    Columns::Responsive(Responsive {
        compact: Some(compact),
        base: Preset::Fixed(base),
        wide: None,
    })
}

fn image(kind: Kind) -> LibraryCardMedia {
    LibraryCardMedia::Image {
        src: picture_of(kind),
    }
}

/// The eight items of the grids: a quote, six pictures, a document.
fn media(index: usize, c: &Copy) -> LibraryCardMedia {
    match index {
        0 => LibraryCardMedia::Quote {
            text: c.quote.into(),
        },
        1 => image(Kind::Product),
        2 => image(Kind::Recipe),
        3 => image(Kind::Paper),
        4 => image(Kind::Library),
        5 | 6 => image(Kind::Place),
        _ => LibraryCardMedia::Document,
    }
}

fn menu(id: String, c: &Copy) -> OverflowActionMenu {
    OverflowActionMenu::new(id, c.more)
        .item(OverflowItem::new(c.attach).icon(Icon::MessageSquarePlus))
        .item(OverflowItem::new(c.open).icon(Icon::Popup))
        .item(OverflowItem::new(c.remove).icon(Icon::Trash2).destructive())
}

fn grid(lang: Lang, id: &'static str, base: u8, count: usize) -> AnyElement {
    let c = copy(lang);
    let tags = [
        c.element, c.element, c.element, c.view, c.view, c.view, c.view, c.doc,
    ];
    let cards = (0..count).map(|index| {
        let (title, meta) = c.items[index];
        LibraryCard::new(format!("{id}-{index}"), media(index, &c), title)
            .meta(meta)
            .tag(tags[index])
            .menu(menu(format!("{id}-{index}-menu"), &c))
            .selected(index == 1)
            .on_open(|_, _, _| {})
    });
    Grid::new(id)
        .columns(columns(base, 1))
        .gap(Space::Md)
        .children(cards)
        .into_any_element()
}

/// Tags (2 and "+N"), no tags, selection mode with two selected, a rename in place, a dragged card.
fn organizing(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let base = |id: &'static str, media: LibraryCardMedia, title: &'static str| {
        LibraryCard::new(id, media, title)
            .meta(c.items[1].1)
            .tag(c.element)
            .select_label(c.select)
            .on_selected_change(|_, _, _, _| {})
            .on_open(|_, _, _| {})
    };
    let rename = LibraryCardEditing::new(c.items[6].0, c.name, |_, _, _| {}, |_, _| {});
    Grid::new("lc-organizing")
        .columns(columns(4, 1))
        .gap(Space::Md)
        .child(
            base("lc-org-0", image(Kind::Product), c.items[1].0)
                .tags(c.tags)
                .selection_mode(true)
                .selected(true),
        )
        .child(
            base("lc-org-1", image(Kind::Recipe), c.items[2].0)
                .tags(c.tags[..1].iter().copied())
                .selection_mode(true)
                .selected(true),
        )
        .child(base("lc-org-2", media(0, &c), c.items[0].0).selection_mode(true))
        .child(
            base("lc-org-3", LibraryCardMedia::Document, c.items[7].0)
                .tag(c.doc)
                .tags(c.tags[2..3].iter().copied()),
        )
        .child(base("lc-org-4", image(Kind::Place), c.items[6].0).editing(rename))
        .child(base("lc-org-5", image(Kind::Paper), c.items[3].0).dragging(true))
        .into_any_element()
}

/// Typical crops (a square card, a page view) span the slot; extreme ones (a page title, a
/// heading strip, a line of text, a tall column) sit whole, inset on the matte.
fn crops(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let items = [
        (Kind::Product, c.items[1].0, c.element),
        (Kind::Place, c.crops[3], c.view),
        (Kind::Strip, c.crops[4], c.element),
        (Kind::Paper, c.crops[0], c.element),
        (Kind::Strip, c.crops[1], c.element),
        (Kind::Column, c.crops[2], c.element),
    ];
    let cards = items
        .into_iter()
        .enumerate()
        .map(|(index, (kind, title, tag))| {
            LibraryCard::new(format!("lc-crop-{index}"), image(kind), title)
                .meta("shop.example.com")
                .tag(tag)
                .on_open(|_, _, _| {})
        });
    Grid::new("lc-crops")
        .columns(columns(4, 1))
        .gap(Space::Md)
        .children(cards)
        .into_any_element()
}

/// Block scraps render the block itself, scaled into the media box: theme and content stay live.
fn blocks(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let metrics = MetricGrid::new("lc-metrics")
        .child(
            MetricCard::text("lc-spend", "₩1,240,000", c.spend)
                .change("+8%")
                .trend(Trend::Down),
        )
        .child(
            MetricCard::text("lc-income", "₩3,100,000", c.income)
                .change("+2%")
                .trend(Trend::Up),
        );
    let checklist = StatusChecklist::new(
        c.steps
            .iter()
            .enumerate()
            .map(|(index, text)| ChecklistItem::new(*text, index == 0)),
    );
    let block = |id: &'static str, content: AnyElement, title: &'static str| {
        LibraryCard::new(id, LibraryCardMedia::Block { content }, title)
            .meta("Butler · Today")
            .tag(c.block)
            .on_open(|_, _, _| {})
    };
    Grid::new("lc-blocks")
        .columns(columns(3, 1))
        .gap(Space::Md)
        .child(block(
            "lc-block-0",
            metrics.into_any_element(),
            c.block_titles[0],
        ))
        .child(block(
            "lc-block-1",
            checklist.into_any_element(),
            c.block_titles[1],
        ))
        .child(
            LibraryCard::new("lc-block-2", LibraryCardMedia::Document, c.items[7].0)
                .meta(c.items[7].1)
                .tag(c.doc)
                .on_open(|_, _, _| {}),
        )
        .into_any_element()
}
