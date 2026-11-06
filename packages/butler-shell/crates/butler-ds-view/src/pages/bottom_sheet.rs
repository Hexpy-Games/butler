//! BottomSheet.showcase.tsx: a direct sheet (a short choice list, an expandable long list) and
//! the sheet presentation of DropdownMenu, Select and Popover. Each story shows its trigger; the
//! live harness opens the sheet and drags it.
use butler_ds::ui::Icon;
use butler_ds::ui::bottom_sheet::{BottomSheet, BottomSheetItem, SheetContent};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::dropdown_menu::{
    DropdownMenu, DropdownMenuContent, Item, Variant as MenuVariant,
};
use butler_ds::ui::layout::Stack;
use butler_ds::ui::overlay::Presentation;
use butler_ds::ui::popover::{
    Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle,
};
use butler_ds::ui::select::{Select, SelectContent, SelectItem, SelectTrigger};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Window};

use super::{Story, probe};
use crate::copy::Lang;

struct Copy {
    close: &'static str,
    tool: &'static str,
    brush: &'static str,
    eraser: &'static str,
    qualities: [&'static str; 3],
    more: &'static str,
    edit: &'static str,
    duplicate: &'static str,
    download: &'static str,
    remove: &'static str,
    models: &'static str,
    info: &'static str,
    info_body: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            close: "Close",
            tool: "Tool",
            brush: "Brush",
            eraser: "Eraser",
            qualities: ["Low", "Medium", "High"],
            more: "More",
            edit: "Edit",
            duplicate: "Copy",
            download: "Download",
            remove: "Delete",
            models: "Model",
            info: "Size",
            info_body: "1536 × 1024 · PNG",
        },
        Copy {
            close: "닫기",
            tool: "도구",
            brush: "브러시",
            eraser: "지우개",
            qualities: ["낮음", "보통", "높음"],
            more: "더 보기",
            edit: "편집",
            duplicate: "복사",
            download: "다운로드",
            remove: "삭제",
            models: "모델",
            info: "크기",
            info_body: "1536 × 1024 · PNG",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Choice list",
            render: tool_sheet,
        },
        Story {
            name: "Expandable long list",
            render: long_sheet,
        },
        Story {
            name: "DropdownMenu presentation=\"sheet\"",
            render: menu_as_sheet,
        },
        Story {
            name: "Select presentation=\"auto\"",
            render: select_auto,
        },
        Story {
            name: "Popover presentation=\"sheet\"",
            render: popover_as_sheet,
        },
    ]
}

/// An outline button that opens `sheet`.
fn opener(sheet: &BottomSheet, id: &'static str, text: &'static str) -> AnyElement {
    let sheet = sheet.clone();
    Button::new(id)
        .variant(Variant::Outline)
        .size(Size::Default)
        .text(text)
        .on_click(move |_, window, cx| sheet.set_open(true, window, cx))
        .into_any_element()
}

/// Direct use: a short choice list. The chosen tool is the story's own state.
fn tool_sheet(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let tool = window.use_keyed_state("sheet-tool", cx, |_, _| 0_usize);
    let current = *tool.read(cx);
    let sheet = BottomSheet::new("sheet-tool-sheet", window, cx);
    let item = |index: usize, name: &'static str, glyph: Icon| {
        let tool = tool.clone();
        BottomSheetItem::new(("sheet-tool-item", index), name)
            .icon(glyph)
            .selected(current == index)
            .on_select(move |_, _, cx| tool.update(cx, |tool, _| *tool = index))
    };
    let content = sheet.content(
        SheetContent::new(c.tool, c.close)
            .item(item(0, c.brush, Icon::Brush))
            .item(item(1, c.eraser, Icon::Eraser)),
        window,
        cx,
    );
    Stack::new()
        .child(opener(&sheet, "sheet-tool-trigger", c.tool))
        .child(content)
        .child(probe(format!("sheet-tool-{current}")))
        .into_any_element()
}

/// Expandable: rests at half height; drag the grabber up for the full list.
fn long_sheet(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    const NAMES: [&str; 6] = [
        "GPT Image 2.5 Sunburst",
        "GPT Image 2.5 Flare",
        "GPT Image 2",
        "Nano Banana 2.1",
        "Nano Banana Pro",
        "Nano Banana 2 Lite",
    ];
    let value = window.use_keyed_state("sheet-model", cx, |_, _| 0_usize);
    let current = *value.read(cx);
    let sheet = BottomSheet::new("sheet-long-sheet", window, cx);
    let mut content = SheetContent::new(c.models, c.close).expandable();
    for (index, name) in NAMES.iter().chain(NAMES.iter()).enumerate() {
        let value = value.clone();
        let slot = index % NAMES.len();
        content = content.item(
            BottomSheetItem::new(("sheet-long-item", index), *name)
                .selected(index < NAMES.len() && slot == current)
                .on_select(move |_, _, cx| value.update(cx, |value, _| *value = slot)),
        );
    }
    let content = sheet.content(content, window, cx);
    Stack::new()
        .child(opener(&sheet, "sheet-long-trigger", c.models))
        .child(content)
        .into_any_element()
}

/// `presentation="sheet"`: the same DropdownMenu, opened as a sheet.
fn menu_as_sheet(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let chose = window.use_keyed_state("sheet-menu-chose", cx, |_, _| 0_usize);
    let held = *chose.read(cx);
    let menu = DropdownMenu::new("sheet-menu", window, cx);
    let trigger = menu.trigger(|toggle| {
        Button::new("sheet-menu-trigger")
            .variant(Variant::Outline)
            .size(Size::Default)
            .text(c.more)
            .on_click(toggle.on_click())
            .into_any_element()
    });
    let content = menu.content(
        DropdownMenuContent::new()
            .presentation(Presentation::Sheet)
            .child(
                Item::new(c.edit)
                    .icon(Icon::Pencil)
                    .on_select(choose(&chose, 1)),
            )
            .child(
                Item::new(c.duplicate)
                    .icon(Icon::Copy)
                    .on_select(choose(&chose, 2)),
            )
            .child(
                Item::new(c.download)
                    .icon(Icon::Download)
                    .on_select(choose(&chose, 3)),
            )
            .child(
                Item::new(c.remove)
                    .icon(Icon::Trash2)
                    .variant(MenuVariant::Destructive)
                    .on_select(choose(&chose, 4)),
            ),
        window,
        cx,
    );
    Stack::new()
        .child(trigger)
        .child(content)
        .child(probe(format!("sheet-menu-chose-{held}")))
        .into_any_element()
}

/// Remembers which item ran, for the harness to read back.
fn choose(chose: &gpui::Entity<usize>, index: usize) -> impl Fn(&mut Window, &mut App) + 'static {
    let chose = chose.clone();
    move |_, cx| chose.update(cx, |chose, _| *chose = index)
}

/// `presentation="auto"`: a sheet below 768px, an anchored list above.
fn select_auto(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let select = Select::new("sheet-select", window, cx).default_value("1", cx);
    let mut content = SelectContent::new().presentation(Presentation::Auto);
    for (index, quality) in c.qualities.iter().enumerate() {
        content = content.child(SelectItem::new(
            SharedString::from(index.to_string()),
            *quality,
        ));
    }
    let trigger = select.trigger(SelectTrigger::new("sheet-select-trigger"), &content, cx);
    let held = select
        .selected(cx)
        .map_or_else(|| "none".to_owned(), |value| value.to_string());
    Stack::new()
        .child(trigger)
        .child(select.content(&content, window, cx))
        .child(probe(format!("sheet-select-value-{held}")))
        .into_any_element()
}

fn popover_as_sheet(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let popover = Popover::new("sheet-popover", window, cx);
    let trigger = popover.trigger(|toggle| {
        Button::new("sheet-popover-trigger")
            .variant(Variant::Outline)
            .size(Size::Default)
            .text(c.info)
            .on_click(toggle.on_click())
            .into_any_element()
    });
    let content = popover.content(
        PopoverContent::new()
            .presentation(Presentation::Sheet)
            .child(
                PopoverHeader::new()
                    .child(PopoverTitle::new(c.info))
                    .child(PopoverDescription::new(c.info_body)),
            ),
        window,
        cx,
    );
    Stack::new()
        .child(trigger)
        .child(content)
        .into_any_element()
}
