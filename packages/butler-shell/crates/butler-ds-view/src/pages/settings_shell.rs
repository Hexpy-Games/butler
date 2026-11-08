//! SettingsShell.showcase.tsx: the start-aligned page in a narrow container, a single card whose
//! description repeats the page (FormSection drops it), the cards frame where the nav takes the
//! shell's row fills, and the page transition between two pages.
use butler_ds::tokens::Color;
use butler_ds::ui::blocks::form_section::FormSection;
use butler_ds::ui::blocks::scope::{self, ShellFrame, ShellVars, Spec};
use butler_ds::ui::blocks::settings_field::SettingsField;
use butler_ds::ui::blocks::settings_header::SettingsHeader;
use butler_ds::ui::blocks::settings_nav::{SettingsNav, SettingsNavItem};
use butler_ds::ui::blocks::settings_shell::SettingsShell;
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::switch::Switch;
use butler_ds::ui::text::Input;
use gpui::{
    AnyElement, App, Entity, IntoElement as _, ParentElement as _, Styled as _, Window, div, px,
};

use super::{Story, sub};
use crate::copy::Lang;

/// The viewer frame: a bounded window height for the shell.
const FRAME_HEIGHT: f32 = 520.; // DS: SettingsShell.showcase.module.css:4

struct Copy {
    general: &'static str,
    region: &'static str,
    servers: &'static str,
    mcp: &'static str,
    mcp_description: &'static str,
    general_description: &'static str,
    notifications: &'static str,
    language: &'static str,
    smart_groups: &'static str,
    replies: &'static str,
    server: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            general: "General",
            region: "Language & region",
            servers: "Servers",
            mcp: "MCP",
            mcp_description: "Manage MCP servers and their connection settings.",
            general_description:
                "Configure language, timezone, conversation input, and search defaults.",
            notifications: "Notifications",
            language: "Language",
            smart_groups: "Smart groups",
            replies: "New replies",
            server: "Server URL",
        },
        Copy {
            general: "일반",
            region: "언어 및 지역",
            servers: "서버",
            mcp: "MCP",
            mcp_description: "MCP 서버와 연결 정보를 관리합니다.",
            general_description: "언어, 시간대, 대화 입력과 검색 기본값을 설정합니다.",
            notifications: "알림",
            language: "언어",
            smart_groups: "스마트 그룹",
            replies: "새 답변",
            server: "서버 URL",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Start-aligned page (narrow PageContainer)",
            render: |lang, _, _| page(lang, 0, "ss-general", false, None),
        },
        Story {
            name: "Single card whose description repeats the page",
            render: |lang, _, _| page(lang, 1, "ss-mcp", false, None),
        },
        Story {
            name: "Cards frame: nav fills follow the shell (macOS)",
            render: cards_frame,
        },
        Story {
            name: "Page transition (select a page: down rises, up drops; reduced motion fades)",
            render: navigable,
        },
    ]
}

fn nav(lang: Lang, active: usize, id: &'static str, select: Option<&Entity<usize>>) -> AnyElement {
    let c = copy(lang);
    let items = [("general", c.general), ("mcp", c.mcp)]
        .into_iter()
        .enumerate()
        .map(|(index, (key, label))| {
            let mut item = SettingsNavItem::new(key, label).active(index == active);
            if let Some(select) = select {
                let select = select.clone();
                item = item.on_select(move |_, _, cx| {
                    select.update(cx, |page, cx| {
                        *page = index;
                        cx.notify();
                    });
                });
            }
            item
        });
    SettingsNav::new(id).items(items).into_any_element()
}

/// The detail of page `index` (0 General, 1 MCP).
fn detail(lang: Lang, index: usize, id: &'static str) -> AnyElement {
    let c = copy(lang);
    if index == 1 {
        // The description repeats the page description: FormSection drops it; the title stays.
        return FormSection::new(c.servers)
            .description(c.mcp_description)
            .holds_field()
            .child(
                SettingsField::new(c.server)
                    .setting_id(sub(id, "server"))
                    .control(
                        Input::new(sub(id, "server-input")).default_value("http://127.0.0.1:8931"),
                    ),
            )
            .into_any_element();
    }
    Stack::new()
        .gap(Space::Xxl)
        .child(
            FormSection::new(c.region)
                .holds_field()
                .child(
                    SettingsField::new(c.language)
                        .setting_id(sub(id, "language"))
                        .control(
                            Input::new(sub(id, "language-input"))
                                .default_value(lang.pick("English", "한국어")),
                        ),
                )
                .child(
                    SettingsField::new(c.smart_groups)
                        .setting_id(sub(id, "groups"))
                        .control(Switch::new(sub(id, "groups-switch")).default_checked(true)),
                ),
        )
        .child(
            FormSection::new(c.notifications).holds_field().child(
                SettingsField::new(c.replies)
                    .setting_id(sub(id, "replies"))
                    .control(Switch::new(sub(id, "replies-switch"))),
            ),
        )
        .into_any_element()
}

/// One page of the shell: `index` 0 is General, 1 is MCP.
fn page(
    lang: Lang,
    index: usize,
    id: &'static str,
    active: bool,
    select: Option<&Entity<usize>>,
) -> AnyElement {
    let c = copy(lang);
    let (title, description) = if index == 0 {
        (c.general, c.general_description)
    } else {
        (c.mcp, c.mcp_description)
    };
    let header = SettingsHeader::new(title).description(description);
    let mut shell = SettingsShell::new(id)
        .page_title(title)
        .page_description(description)
        .page_key(title)
        .page_order(i32::try_from(index).unwrap_or(i32::MAX))
        .sidebar(nav(lang, index, id, select))
        .detail_header(header)
        .detail(detail(lang, index, id));
    if active {
        shell = shell.active();
    }
    div()
        .h(px(FRAME_HEIGHT))
        .overflow_hidden()
        .child(shell)
        .into_any_element()
}

/// The docked cards frame: the shell's vars say so, so the nav takes the shell's row fills and the
/// detail pane is a card under the title row. The surface stands in for the desktop under it.
fn cards_frame(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let vars = ShellVars {
        frame: ShellFrame::Cards,
        collapsed_left_padding: 0.,
        window_controls_width: 0.,
        chrome_toggle_left: 0.,
        cards_docked: true,
        transparent_workspace: false,
        split: None,
        sidebar_peek: false,
        card_start: 0.,
        card_end: 0.,
    };
    let surface = Ds::get(cx).color(Color::Surface);
    let shell = page(lang, 0, "ss-cards", true, None);
    let spec = Spec {
        vars: Some(vars),
        ..Spec::default()
    };
    div()
        .bg(surface)
        .child(scope::scoped(spec, shell))
        .into_any_element()
}

/// Selecting a page re-enters the header and content from the direction of travel.
fn navigable(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let selected = window.use_keyed_state(sub("ss-nav", "page"), cx, |_, _| 0usize);
    let index = *selected.read(cx);
    page(lang, index, "ss-nav", false, Some(&selected))
}
