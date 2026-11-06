//! IconButton.showcase.tsx and IconButton.paneDemo.tsx.
use butler_ds::ui::Icon;
use butler_ds::ui::button::{Size, container};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::{IconButton, Pane, Tone as IconTone};
use butler_ds::ui::layout::{Cross, Justify, Space, Stack};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    back: &'static str,
    hide_left: &'static str,
    hide_right: &'static str,
    minimize: &'static str,
    maximize: &'static str,
    close: &'static str,
    dashboard: &'static str,
    new_chat: &'static str,
    new_project: &'static str,
    pin: &'static str,
    edit: &'static str,
    remove: &'static str,
    more: &'static str,
    note: &'static str,
    browser_show: &'static str,
    browser_hide: &'static str,
    browser_active: &'static str,
    pick: [&'static str; 2],
    tone_note: &'static str,
    pane: [&'static str; 3],
    pane_note: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            back: "Back",
            hide_left: "Hide left panel",
            hide_right: "Hide right panel",
            minimize: "Minimize window",
            maximize: "Maximize window",
            close: "Close window",
            dashboard: "Project dashboard",
            new_chat: "New chat in project",
            new_project: "New project",
            pin: "Pin",
            edit: "Edit description",
            remove: "Delete row",
            more: "Session actions",
            note: "Hover or focus a button: the label shows as a tooltip unless it opens a menu.",
            browser_show: "Show browser",
            browser_hide: "Hide browser",
            browser_active: "Butler is browsing",
            pick: ["Pick elements, 3 selected", "Pick elements, 12 selected"],
            tone_note: "Tones colour the icon only. An open pane's toggle (pane) also fills with that pane's surface.",
            pane: ["Session info", "File viewer", "Hide browser"],
            pane_note: "Closed, then open: each toggle fills with the surface of the pane it opened, opaque.",
        },
        Copy {
            back: "뒤로",
            hide_left: "왼쪽 패널 숨기기",
            hide_right: "오른쪽 패널 숨기기",
            minimize: "창 최소화",
            maximize: "창 최대화",
            close: "창 닫기",
            dashboard: "프로젝트 대시보드",
            new_chat: "프로젝트에서 새 채팅",
            new_project: "새 프로젝트",
            pin: "고정",
            edit: "설명 편집",
            remove: "행 삭제",
            more: "세션 작업",
            note: "버튼에 마우스를 올리거나 포커스하면 라벨이 툴팁으로 보입니다. 메뉴를 여는 버튼은 제외입니다.",
            browser_show: "브라우저 열기",
            browser_hide: "브라우저 닫기",
            browser_active: "버틀러가 브라우저 사용 중",
            pick: ["요소 선택, 3개 선택됨", "요소 선택, 12개 선택됨"],
            tone_note: "톤은 아이콘 색만 바꿉니다. 창을 여는 토글(pane)은 열린 동안 그 창의 바탕색으로 채웁니다.",
            pane: ["세션 정보", "파일 보기", "브라우저 닫기"],
            pane_note: "닫힘, 그다음 열림: 토글은 자신이 연 창의 바탕색을 불투명하게 채웁니다.",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Tones, indicator and badge (browser toggle)",
            render: browser_toggles,
        },
        Story {
            name: "Pane toggles: closed, then open (fill = the pane's surface)",
            render: pane_toggles,
        },
        Story {
            name: "Titlebar and window controls",
            render: titlebar,
        },
        Story {
            name: "Row actions",
            render: row_actions,
        },
        Story {
            name: "Menu trigger (selected while open)",
            render: menu_trigger,
        },
        Story {
            name: "Disabled",
            render: disabled,
        },
        Story {
            name: "Optical top-end alignment",
            render: optical,
        },
    ]
}

fn md(cx: &App, glyph: Icon) -> butler_ds::ui::icon::IconView {
    icon(glyph, IconSize::Md, Ds::get(cx))
}

fn caption(text: &'static str) -> Typo {
    Typo::caption(text).tone(Tone::Secondary)
}

fn browser_toggles(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let button = |id: &'static str, label: &'static str, icon: Icon| {
        IconButton::new(id, label).icon(md(cx, icon))
    };
    Stack::new()
        .gap(Space::Sm)
        .child(
            container(Size::IconSm)
                .child(button("ib-show", c.browser_show, Icon::Globe2).pressed(false))
                .child(
                    button("ib-hide", c.browser_hide, Icon::Globe2)
                        .pane(Pane::Browser)
                        .pressed(true)
                        .tone(IconTone::Butler),
                )
                .child(
                    button("ib-active", c.browser_active, Icon::Globe2)
                        .pressed(false)
                        .tone(IconTone::Riso)
                        .indicator(),
                )
                .child(
                    button("ib-riso", c.browser_hide, Icon::Globe2)
                        .pane(Pane::Browser)
                        .pressed(true)
                        .tone(IconTone::Riso),
                )
                .child(button("ib-pick3", c.pick[0], Icon::Pick).badge(3))
                .child(button("ib-pick12", c.pick[1], Icon::Pick).badge(12)),
        )
        .child(caption(c.tone_note))
        .into_any_element()
}

fn pane_toggles(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let panes = [
        (Pane::Aside, Icon::AppleReminder, c.pane[0]),
        (Pane::Viewer, Icon::FileText, c.pane[1]),
        (Pane::Browser, Icon::Globe2, c.pane[2]),
    ];
    let row = |open: bool| {
        panes
            .iter()
            .fold(container(Size::IconSm), |row, (pane, glyph, label)| {
                let mut button = IconButton::new(format!("pane-{open}-{label}"), *label)
                    .icon(md(cx, *glyph))
                    .pane(*pane)
                    .pressed(open);
                if open {
                    button = button.tone(IconTone::Butler);
                }
                if *pane == Pane::Aside {
                    button = button.indicator();
                }
                row.child(button)
            })
    };
    Stack::new()
        .gap(Space::Sm)
        .child(row(false))
        .child(row(true))
        .child(caption(c.pane_note))
        .into_any_element()
}

fn titlebar(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let button = |id: &'static str, label: &'static str, glyph: Icon| {
        IconButton::new(id, label)
            .icon(md(cx, glyph))
            .on_click(|_, _, _| {})
    };
    Stack::new()
        .gap(Space::Sm)
        .child(
            container(Size::Sm)
                .child(button("tb-left", c.hide_left, Icon::PanelLeft))
                .child(button("tb-back", c.back, Icon::ArrowLeft))
                .child(button("tb-right", c.hide_right, Icon::PanelRightClose))
                .child(button("tb-min", c.minimize, Icon::Minus))
                .child(button("tb-max", c.maximize, Icon::Square))
                .child(button("tb-close", c.close, Icon::X)),
        )
        .child(caption(c.note))
        .into_any_element()
}

fn row_actions(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    container(Size::Sm)
        .child(
            IconButton::new("row-dashboard", c.dashboard)
                .icon(icon(Icon::LayoutDashboard, IconSize::Md, ds))
                .on_click(|_, _, _| {}),
        )
        .child(
            IconButton::new("row-new-chat", c.new_chat)
                .icon(icon(Icon::MessageSquarePlus, IconSize::Sm, ds))
                .on_click(|_, _, _| {}),
        )
        .child(
            IconButton::new("row-pin", c.pin)
                .icon(icon(Icon::Pin, IconSize::Md, ds))
                .on_click(|_, _, _| {}),
        )
        .child(
            IconButton::new("row-edit", c.edit)
                .icon(icon(Icon::Pencil, IconSize::Md, ds))
                .on_click(|_, _, _| {}),
        )
        .child(
            IconButton::new("row-delete", c.remove)
                .icon(icon(Icon::Trash2, IconSize::Md, ds))
                .on_click(|_, _, _| {}),
        )
        .into_any_element()
}

fn menu_trigger(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    container(Size::Sm)
        .child(
            IconButton::new("menu-open", c.new_project)
                .icon(md(cx, Icon::FolderPlus))
                .selected()
                .menu_trigger(),
        )
        .child(
            IconButton::new("menu-closed", c.more)
                .icon(md(cx, Icon::MoreHorizontal))
                .menu_trigger(),
        )
        .into_any_element()
}

fn disabled(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    IconButton::new("ib-disabled", copy(lang).remove)
        .icon(md(cx, Icon::Trash2))
        .disabled()
        .into_any_element()
}

fn optical(_: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    Stack::row()
        .cross(Cross::Start)
        .justify(Justify::Between)
        .gap(Space::Sm)
        .child(Typo::label("Card title"))
        .child(
            IconButton::new("ib-optical", "Open details")
                .icon(md(cx, Icon::Eye))
                .optical_top_end(),
        )
        .into_any_element()
}
