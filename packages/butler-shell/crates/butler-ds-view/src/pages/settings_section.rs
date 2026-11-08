//! SettingsSection.showcase.tsx. CardListItem is not ported yet, so `server_row` composes it
//! from a KeyValueRow.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::key_value_row::KeyValueRow;
use butler_ds::ui::blocks::progress_meter::ProgressMeter;
use butler_ds::ui::blocks::settings_action_field::SettingsActionField;
use butler_ds::ui::blocks::settings_field::SettingsField;
use butler_ds::ui::blocks::settings_section::{
    SettingsPage, SettingsSection, SettingsSectionKind, SettingsSectionLabels, SettingsSectionMore,
    SettingsSectionState,
};
use butler_ds::ui::button::{Button, Size, Variant, container};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Cross, Justify, Space, Stack};
use butler_ds::ui::segmented_control::{Choice, SegmentedControl, Size as SegSize};
use butler_ds::ui::switch::Switch;
use butler_ds::ui::text::Input;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    labels: SettingsSectionLabels,
    region: &'static str,
    language: &'static str,
    timezone: &'static str,
    notifications: &'static str,
    replies: &'static str,
    check: &'static str,
    versions: &'static str,
    app: &'static str,
    up_to_date: &'static str,
    servers: &'static str,
    usage: &'static str,
    archived: &'static str,
    no_servers: &'static str,
    add: &'static str,
    more: &'static str,
    refresh: &'static str,
    profile: &'static str,
    nickname: &'static str,
    nickname_value: &'static str,
    save: &'static str,
    cancel: &'static str,
    storage: &'static str,
    agent_logs: &'static str,
    agent_meta: &'static str,
    clear: &'static str,
    clear_description: &'static str,
    clear_action: &'static str,
    period: &'static str,
    periods: [&'static str; 3],
    tokens: &'static str,
    cost: &'static str,
    enabled: &'static str,
    rows: [(&'static str, &'static str); 3],
}

fn copy(lang: Lang) -> Copy {
    lang.pick(english(), korean())
}

fn english() -> Copy {
    Copy {
        labels: SettingsSectionLabels::new()
            .loading("Loading")
            .error("Could not load this section.")
            .retry("Retry")
            .empty("Nothing to show yet."),
        region: "Language & region",
        language: "Language",
        timezone: "Time zone",
        notifications: "Notifications",
        replies: "New replies",
        check: "Check for updates",
        versions: "Versions",
        app: "Butler",
        up_to_date: "Up to date",
        servers: "Servers",
        usage: "Usage",
        archived: "Archived items",
        no_servers: "No MCP servers yet.",
        add: "Add server",
        more: "More",
        refresh: "Refresh",
        profile: "Profile",
        nickname: "Nickname",
        nickname_value: "Sam",
        save: "Save",
        cancel: "Cancel",
        storage: "Storage",
        agent_logs: "Agent",
        agent_meta: "12 MB of 100 MB · 14 days",
        clear: "Delete all logs",
        clear_description: "Removes saved logs and bodies. This can't be undone.",
        clear_action: "Delete all…",
        period: "Period",
        periods: ["Day", "Week", "Month"],
        tokens: "Tokens",
        cost: "Cost",
        enabled: "On",
        rows: [
            ("filesystem", "stdio · 12 tools"),
            ("github", "http · 31 tools"),
            ("linear", "http · Needs a key"),
        ],
    }
}

fn korean() -> Copy {
    Copy {
        labels: SettingsSectionLabels::new()
            .loading("불러오는 중")
            .error("이 섹션을 불러오지 못했습니다.")
            .retry("다시 시도")
            .empty("아직 표시할 항목이 없습니다."),
        region: "언어 및 지역",
        language: "언어",
        timezone: "시간대",
        notifications: "알림",
        replies: "새 답변",
        check: "업데이트 확인",
        versions: "버전",
        app: "버틀러",
        up_to_date: "최신 버전",
        servers: "서버",
        usage: "사용량",
        archived: "보관된 항목",
        no_servers: "아직 MCP 서버가 없습니다.",
        add: "서버 추가",
        more: "더보기",
        refresh: "새로고침",
        profile: "프로필",
        nickname: "호칭",
        nickname_value: "지수",
        save: "저장",
        cancel: "취소",
        storage: "저장 공간",
        agent_logs: "에이전트",
        agent_meta: "100 MB 중 12 MB · 14일",
        clear: "로그 모두 삭제",
        clear_description: "저장된 로그와 본문을 지웁니다. 되돌릴 수 없습니다.",
        clear_action: "모두 삭제…",
        period: "기간",
        periods: ["일", "주", "월"],
        tokens: "토큰",
        cost: "비용",
        enabled: "사용",
        rows: [
            ("filesystem", "stdio · 도구 12개"),
            ("github", "http · 도구 31개"),
            ("linear", "http · 키 필요"),
        ],
    }
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Form sections",
            render: form,
        },
        Story {
            name: "Header actions, loading, error and empty",
            render: states,
        },
        Story {
            name: "List rows flush in the card, more row",
            render: flush_list,
        },
        Story {
            name: "Status header actions: period and refresh",
            render: status_actions,
        },
        Story {
            name: "Status card with an action row (field gap)",
            render: status_with_action,
        },
        Story {
            name: "Explicit-save page: the only sticky footer",
            render: explicit_save,
        },
    ]
}

fn add_button(id: &'static str, label: &'static str, cx: &App) -> Button {
    Button::new(id)
        .size(Size::Sm)
        .variant(Variant::Outline)
        .icon_start(icon(Icon::Plus, IconSize::Md, Ds::get(cx)))
        .text(label)
}

fn refresh_button(id: &'static str, label: &'static str, size: IconSize, cx: &App) -> Button {
    Button::new(id)
        .size(Size::Sm)
        .variant(Variant::Outline)
        .icon_start(icon(Icon::RefreshCcw, size, Ds::get(cx)))
        .text(label)
}

fn form(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    SettingsPage::new()
        .labels(c.labels)
        .section(
            SettingsSection::new("language-region", SettingsSectionKind::Form, c.region)
                .holds_fields()
                .child(
                    SettingsField::new(c.language)
                        .control(Input::new("sc-language").default_value("English")),
                )
                .child(
                    SettingsField::new(c.timezone)
                        .control(Input::new("sc-timezone").default_value("Asia/Seoul")),
                ),
        )
        .section(
            SettingsSection::new("notifications", SettingsSectionKind::Form, c.notifications)
                .holds_fields()
                .child(
                    SettingsField::new(c.replies)
                        .control(Switch::new("sc-replies").default_checked(true)),
                ),
        )
        .into_any_element()
}

fn states(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    SettingsPage::new()
        .labels(c.labels)
        .section(
            SettingsSection::new("updates", SettingsSectionKind::List, c.versions)
                .actions(refresh_button("sc-check", c.check, IconSize::Md, cx))
                .child(KeyValueRow::new(c.app, c.up_to_date)),
        )
        .section(
            SettingsSection::new("loading", SettingsSectionKind::List, c.servers)
                .state(SettingsSectionState::Loading),
        )
        .section(
            SettingsSection::new("error", SettingsSectionKind::Status, c.usage)
                .state(SettingsSectionState::Error)
                .on_retry(|_, _, _| {}),
        )
        .section(
            SettingsSection::new("empty", SettingsSectionKind::List, c.servers)
                .state(SettingsSectionState::Empty)
                .empty_message(c.no_servers)
                .actions(add_button("sc-add-empty", c.add, cx)),
        )
        .into_any_element()
}

fn server_row(c: &Copy, name: &'static str, meta: &'static str) -> AnyElement {
    KeyValueRow::new(name, c.enabled)
        .description(meta)
        .into_any_element()
}

fn flush_list(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let servers = c
        .rows
        .iter()
        .map(|&(name, meta)| server_row(&c, name, meta));
    let archived = c
        .rows
        .iter()
        .map(|&(name, meta)| server_row(&c, name, meta));
    SettingsPage::new()
        .section(
            SettingsSection::new("servers", SettingsSectionKind::List, c.servers)
                .actions(add_button("sc-add", c.add, cx))
                .children(servers),
        )
        .section(
            SettingsSection::new("archived", SettingsSectionKind::List, c.archived)
                .more(SettingsSectionMore::new(c.more, |_, _, _| {}))
                .children(archived),
        )
        .into_any_element()
}

fn status_actions(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let period = SegmentedControl::new("sc-period", c.period, "24")
        .size(SegSize::Sm)
        .options(
            ["24", "168", "720"]
                .into_iter()
                .zip(c.periods)
                .map(|(value, label)| Choice::new(value, label)),
        );
    let actions = Stack::row()
        .gap(Space::Sm)
        .cross(Cross::Center)
        .child(period)
        .child(refresh_button("sc-refresh", c.refresh, IconSize::Sm, cx));
    SettingsPage::new()
        .section(
            SettingsSection::new("usage", SettingsSectionKind::Status, c.usage)
                .actions(actions)
                .child(KeyValueRow::new(c.tokens, "1.2M"))
                .child(KeyValueRow::new(c.cost, "$4.20")),
        )
        .into_any_element()
}

fn status_with_action(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let clear = Button::new("sc-clear")
        .size(Size::Sm)
        .variant(Variant::Outline)
        .text(c.clear_action);
    SettingsPage::new()
        .section(
            SettingsSection::new("storage", SettingsSectionKind::Status, c.storage)
                .holds_fields()
                .child(
                    ProgressMeter::new("sc-logs", 12.)
                        .label(c.agent_logs)
                        .meta(c.agent_meta),
                )
                .child(SettingsActionField::new(
                    c.clear,
                    c.clear_description,
                    clear,
                )),
        )
        .into_any_element()
}

fn explicit_save(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let footer = container(Size::Default)
        .justify(Justify::End)
        .child(
            Button::new("sc-cancel")
                .variant(Variant::Outline)
                .text(c.cancel),
        )
        .child(Button::new("sc-save").text(c.save));
    SettingsPage::new()
        .footer(footer)
        .section(
            SettingsSection::new("profile", SettingsSectionKind::Form, c.profile)
                .holds_fields()
                .child(
                    SettingsField::new(c.nickname)
                        .control(Input::new("sc-nickname").default_value(c.nickname_value)),
                ),
        )
        .into_any_element()
}
