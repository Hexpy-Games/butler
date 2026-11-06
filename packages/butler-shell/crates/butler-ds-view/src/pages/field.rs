//! Field.showcase.tsx.
use butler_ds::ui::card::{Card, CardPadding};
use butler_ds::ui::field::{
    Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend,
    FieldSeparator, FieldSet, FieldTitle, Orientation,
};
use butler_ds::ui::native_select::NativeSelect;
use butler_ds::ui::switch::Switch;
use butler_ds::ui::text::{Input, Textarea};
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    legend: &'static str,
    id: &'static str,
    transport: &'static str,
    enabled: &'static str,
    enabled_hint: &'static str,
    command: &'static str,
    args: &'static str,
    args_hint: &'static str,
    or: &'static str,
    url: &'static str,
    required: &'static str,
    too_long: &'static str,
    component: &'static str,
    version: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            legend: "MCP server",
            id: "Server ID",
            transport: "Transport",
            enabled: "Enabled",
            enabled_hint: "Butler connects to this server when a session starts.",
            command: "Command",
            args: "Arguments",
            args_hint: "One per line",
            or: "or",
            url: "Server URL",
            required: "Server ID is required",
            too_long: "Use 64 characters or fewer",
            component: "Butler agent",
            version: "0.0.21 → 0.0.22 is ready to install",
        },
        Copy {
            legend: "MCP 서버",
            id: "서버 ID",
            transport: "연결 방식",
            enabled: "사용",
            enabled_hint: "세션이 시작되면 버틀러가 이 서버에 연결합니다.",
            command: "명령",
            args: "인자",
            args_hint: "한 줄에 하나씩 입력",
            or: "또는",
            url: "서버 URL",
            required: "서버 ID를 입력하세요",
            too_long: "64자 이하로 입력하세요",
            component: "버틀러 에이전트",
            version: "0.0.21 → 0.0.22 설치 준비됨",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Long label above control",
            render: long_label,
        },
        Story {
            name: "MCP server form",
            render: mcp_form,
        },
        Story {
            name: "Switch field: stacked (default)",
            render: switch_stacked,
        },
        Story {
            name: "Switch field: row (phone or list item in a card)",
            render: switch_row,
        },
        Story {
            name: "Status field (update component)",
            render: status,
        },
        Story {
            name: "Separator and errors",
            render: errors,
        },
    ]
}

fn long_label(_: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    Field::new("field-long-label")
        .child(FieldLabel::new().child("L".repeat(40)))
        .child(Input::new("field-long-input").default_value("Butler"))
        .into_any_element()
}

fn mcp_form(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    FieldSet::new()
        .legend(FieldLegend::new().child(c.legend))
        .child(
            FieldGroup::new()
                .child(
                    Field::new("field-id")
                        .child(FieldLabel::new().child(c.id))
                        .child(Input::new("field-id-input").default_value("github")),
                )
                .child(
                    Field::new("field-transport")
                        .child(FieldLabel::new().child(c.transport))
                        .child(
                            NativeSelect::new("field-transport-select")
                                .default_value("stdio")
                                .option("stdio", "stdio")
                                .option("http", "HTTP"),
                        ),
                )
                .child(
                    Field::new("field-args")
                        .child(FieldLabel::new().child(c.args))
                        .child(
                            Textarea::new("field-args-input")
                                .placeholder(c.args_hint)
                                .rows(3),
                        )
                        .child(FieldDescription::new().child(c.args_hint)),
                ),
        )
        .into_any_element()
}

fn switch_stacked(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Field::new("field-switch")
        .child(FieldLabel::new().child(c.enabled))
        .child(FieldDescription::new().child(c.enabled_hint))
        .child(Switch::new("field-switch-control").default_checked(true))
        .into_any_element()
}

fn switch_row(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Card::new("field-card")
        .padding(CardPadding::Md)
        .child(
            Field::new("field-switch-row")
                .orientation(Orientation::Horizontal)
                .content(
                    FieldContent::new()
                        .child(FieldLabel::new().child(c.enabled))
                        .child(FieldDescription::new().child(c.enabled_hint)),
                )
                .child(Switch::new("field-switch-row-control").default_checked(true)),
        )
        .into_any_element()
}

fn status(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Field::new("field-status")
        .child(FieldTitle::new().child(c.component))
        .child(Typo::caption(c.version))
        .into_any_element()
}

fn errors(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    FieldGroup::new()
        .child(
            Field::new("field-command")
                .child(FieldLabel::new().child(c.command))
                .child(
                    Input::new("field-command-input")
                        .invalid()
                        .placeholder("npx"),
                )
                .child(FieldError::new().errors([c.required, c.too_long])),
        )
        .child(FieldSeparator::new().child(c.or))
        .child(
            Field::new("field-url")
                .child(FieldLabel::new().child(c.url))
                .child(Input::new("field-url-input").default_value("https://mcp.example.com/sse"))
                .child(FieldError::new().child(c.required)),
        )
        .into_any_element()
}
