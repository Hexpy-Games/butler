//! DropdownMenu.showcase.tsx. The "Bottom sheet on phones" story opens as a BottomSheet below
//! 768px.
use butler_ds::ui::Icon;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::dropdown_menu::{
    CheckboxItem, Checked, DropdownMenu, DropdownMenuContent, Group, Item, RadioGroup, RadioItem,
    Sub, Variant as ItemVariant,
};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::Stack;
use butler_ds::ui::overlay::Presentation;
use butler_ds::ui::overlay::place::Align;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::{Story, probe};
use crate::copy::Lang;

struct Copy {
    actions: &'static str,
    rename: &'static str,
    open_in: &'static str,
    vscode: &'static str,
    terminal: &'static str,
    archive: &'static str,
    remove: &'static str,
    new_project: &'static str,
    scratch: &'static str,
    existing: &'static str,
    view: &'static str,
    density: &'static str,
    compact: &'static str,
    comfortable: &'static str,
    show_archived: &'static str,
    loading: &'static str,
    tags: &'static str,
    tagged: [(&'static str, Checked); 3],
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            actions: "Session actions",
            rename: "Rename",
            open_in: "Open folder in",
            vscode: "VS Code",
            terminal: "Terminal",
            archive: "Archive",
            remove: "Delete",
            new_project: "New project",
            scratch: "Start from scratch",
            existing: "Open a folder",
            view: "View",
            density: "Sidebar density",
            compact: "Compact",
            comfortable: "Comfortable",
            show_archived: "Show archived",
            loading: "Looking for editors…",
            tags: "Tags",
            tagged: [
                ("jeju", Checked::On),
                ("cafés", Checked::Mixed),
                ("family", Checked::Off),
            ],
        },
        Copy {
            actions: "세션 작업",
            rename: "이름 바꾸기",
            open_in: "다음에서 폴더 열기",
            vscode: "VS Code",
            terminal: "터미널",
            archive: "보관",
            remove: "삭제",
            new_project: "새 프로젝트",
            scratch: "처음부터 시작",
            existing: "폴더 열기",
            view: "보기",
            density: "사이드바 밀도",
            compact: "촘촘하게",
            comfortable: "여유 있게",
            show_archived: "보관된 항목 보기",
            loading: "편집기를 찾는 중…",
            tags: "태그",
            tagged: [
                ("제주", Checked::On),
                ("카페", Checked::Mixed),
                ("가족", Checked::Off),
            ],
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Session actions",
            render: session,
        },
        Story {
            name: "New project menu",
            render: new_project,
        },
        Story {
            name: "Radio and checkbox items",
            render: view,
        },
        Story {
            name: "Checkbox items: all, some (indeterminate), none",
            render: tags,
        },
        Story {
            name: "Bottom sheet on phones (presentation=\"auto\")",
            render: sheet,
        },
    ]
}

fn menu_icon_button(
    menu: &DropdownMenu,
    id: &'static str,
    label: &'static str,
    glyph: Icon,
    cx: &App,
) -> AnyElement {
    let ds = Ds::get(cx);
    menu.trigger(|toggle| {
        IconButton::new(id, label)
            .icon(icon(glyph, IconSize::Md, ds))
            .menu_trigger()
            .on_click(toggle.on_click())
            .into_any_element()
    })
}

fn outline_button(menu: &DropdownMenu, id: &'static str, text: &'static str) -> AnyElement {
    menu.trigger(|toggle| {
        Button::new(id)
            .variant(Variant::Outline)
            .size(Size::Sm)
            .text(text)
            .on_click(toggle.on_click())
            .into_any_element()
    })
}

fn story(trigger: AnyElement, content: AnyElement) -> AnyElement {
    Stack::new()
        .child(trigger)
        .child(content)
        .into_any_element()
}

/// Titlebar session menu: grouped items, a submenu and a destructive item.
fn session(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let menu = DropdownMenu::new("dm-session", window, cx);
    let trigger = menu_icon_button(
        &menu,
        "dm-session-trigger",
        c.actions,
        Icon::MoreHorizontal,
        cx,
    );
    let editors = Sub::new(c.open_in)
        .icon(Icon::Folder)
        .child(Item::new(c.vscode).icon(Icon::Monitor))
        .child(Item::new(c.terminal).icon(Icon::Terminal))
        .child(Item::new(c.loading).disabled());
    let group = Group::new()
        .child(Item::new(c.rename).icon(Icon::PencilLine).shortcut("⌘R"))
        .child(editors)
        .child(Item::new(c.archive).icon(Icon::Archive));
    let content = menu.content(
        DropdownMenuContent::new()
            .align(Align::End)
            .side_offset(8.)
            .child(group)
            .separator()
            .child(
                Item::new(c.remove)
                    .icon(Icon::Trash2)
                    .variant(ItemVariant::Destructive),
            ),
        window,
        cx,
    );
    story(trigger, content)
}

fn new_project(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let menu = DropdownMenu::new("dm-new", window, cx);
    let trigger = menu_icon_button(&menu, "dm-new-trigger", c.new_project, Icon::FolderPlus, cx);
    let content = menu.content(
        DropdownMenuContent::new()
            .align(Align::End)
            .side_offset(8.)
            .child(
                Group::new()
                    .child(Item::new(c.scratch))
                    .child(Item::new(c.existing)),
            ),
        window,
        cx,
    );
    story(trigger, content)
}

/// `ViewMenu`: a radio group and a checkbox, each with its own state.
fn view(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let density = window.use_keyed_state("dm-density", cx, |_, _| "comfortable");
    let archived = window.use_keyed_state("dm-archived", cx, |_, _| false);
    let menu = DropdownMenu::new("dm-view", window, cx);
    let trigger = outline_button(&menu, "dm-view-trigger", c.view);
    let (set_density, set_archived) = (density.clone(), archived.clone());
    let group = RadioGroup::new(*density.read(cx))
        .item(RadioItem::new("compact", c.compact))
        .item(RadioItem::new("comfortable", c.comfortable))
        .on_value_change(move |value, _, cx| {
            let next = if value == "compact" {
                "compact"
            } else {
                "comfortable"
            };
            set_density.update(cx, |density, cx| {
                *density = next;
                cx.notify();
            });
        });
    let checkbox = CheckboxItem::new(c.show_archived, *archived.read(cx)).on_checked_change(
        move |on, _, cx| {
            set_archived.update(cx, |archived, cx| {
                *archived = on;
                cx.notify();
            });
        },
    );
    let content = menu.content(
        DropdownMenuContent::new()
            .label(c.density)
            .child(group)
            .separator()
            .child(checkbox),
        window,
        cx,
    );
    Stack::new()
        .child(trigger)
        .child(content)
        .child(probe(format!("dm-density-{}", *density.read(cx))))
        .child(probe(format!("dm-archived-{}", *archived.read(cx))))
        .into_any_element()
}

/// Bulk tags for three selected items: on all, on some, on none.
fn tags(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let menu = DropdownMenu::new("dm-tags", window, cx);
    let trigger = outline_button(&menu, "dm-tags-trigger", c.tags);
    let mut content = DropdownMenuContent::new();
    for (name, checked) in c.tagged {
        content = content.child(CheckboxItem::new(name, checked));
    }
    story(trigger, menu.content(content, window, cx))
}

/// `presentation="auto"`: a BottomSheet below 768px, the anchored menu above.
fn sheet(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let menu = DropdownMenu::new("dm-sheet", window, cx);
    let trigger = menu_icon_button(
        &menu,
        "dm-sheet-trigger",
        c.new_project,
        Icon::FolderPlus,
        cx,
    );
    let content = menu.content(
        DropdownMenuContent::new()
            .presentation(Presentation::Auto)
            .child(Item::new(c.scratch))
            .child(Item::new(c.existing)),
        window,
        cx,
    );
    story(trigger, content)
}
