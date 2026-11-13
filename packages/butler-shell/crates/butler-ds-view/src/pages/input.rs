//! Input.showcase.tsx.
use butler_ds::tokens::Length;
use butler_ds::ui::context::Ds;
use butler_ds::ui::field::{Field, FieldDescription, FieldLabel};
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::text::{Input, InputVariant, TextSize};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window, px};

use super::Story;
use crate::copy::Lang;

struct Copy {
    server_id: &'static str,
    server_name: &'static str,
    placeholder: &'static str,
    api_key: &'static str,
    api_key_hint: &'static str,
    context: &'static str,
    oauth: &'static str,
    invalid: &'static str,
    max_workers: &'static str,
    search: &'static str,
    inline_padding: &'static str,
    name: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            server_id: "Server ID",
            server_name: "Display name",
            placeholder: "Placeholder only",
            api_key: "API key",
            api_key_hint: "Stays on this computer; only the last four characters are shown.",
            context: "Context window",
            oauth: "Sign-in link",
            invalid: "Must be a number",
            max_workers: "Max simultaneous Workers",
            search: "Search settings",
            inline_padding: "Inline padding",
            name: "GitHub",
        },
        Copy {
            server_id: "서버 ID",
            server_name: "표시 이름",
            placeholder: "플레이스홀더만",
            api_key: "API 키",
            api_key_hint: "이 컴퓨터에만 저장되며 마지막 네 글자만 보입니다.",
            context: "컨텍스트 창",
            oauth: "로그인 링크",
            invalid: "숫자를 입력하세요",
            max_workers: "최대 동시 Worker 수",
            search: "설정 검색",
            inline_padding: "안쪽 여백",
            name: "깃허브",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Value and placeholder",
            render: value_and_placeholder,
        },
        Story {
            name: "Settings form (MCP server)",
            render: settings_form,
        },
        Story {
            name: "Masked key (disabled) and read-only link",
            render: masked,
        },
        Story {
            name: "Numeric and invalid",
            render: numeric,
        },
        Story {
            name: "Compact number in a toolbar",
            render: compact,
        },
        Story {
            name: "Underline · in-place entry",
            render: underline,
        },
        Story {
            name: "Inline padding",
            render: inline_padding,
        },
        Story {
            name: "Quiet · sidebar search",
            render: quiet,
        },
    ]
}

fn labelled(id: &'static str, label: &'static str, input: Input) -> Field {
    Field::new(id)
        .child(FieldLabel::new().child(label))
        .child(input)
}

fn value_and_placeholder(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Stack::new()
        .gap(Space::Sm)
        .child(labelled(
            "input-field-server-id",
            c.server_id,
            Input::new("input-server-id")
                .default_value("github")
                .placeholder(c.server_id)
                .probe("input-server-id"),
        ))
        .child(Input::new("input-placeholder").placeholder(c.placeholder))
        .into_any_element()
}

fn settings_form(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Stack::new()
        .gap(Space::Sm)
        .child(labelled(
            "input-field-mcp-id",
            c.server_id,
            Input::new("input-mcp-id").default_value("github"),
        ))
        .child(labelled(
            "input-field-mcp-name",
            c.server_name,
            Input::new("input-mcp-name").default_value(c.name),
        ))
        .into_any_element()
}

fn masked(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Stack::new()
        .gap(Space::Sm)
        .child(
            Field::new("input-field-key")
                .child(FieldLabel::new().child(c.api_key))
                .child(
                    Input::new("input-key")
                        .value("sk-…4f2a")
                        .disabled()
                        .read_only(),
                )
                .child(FieldDescription::new().child(c.api_key_hint)),
        )
        .child(labelled(
            "input-field-oauth",
            c.oauth,
            Input::new("input-oauth")
                .value("https://auth.example.com/device?code=BTLR-7Q2X")
                .read_only(),
        ))
        .into_any_element()
}

fn numeric(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Stack::new()
        .gap(Space::Sm)
        .child(labelled(
            "input-field-context",
            c.context,
            Input::new("input-context").default_value("32768"),
        ))
        .child(
            Field::new("input-field-context-bad")
                .child(FieldLabel::new().child(c.context))
                .child(
                    Input::new("input-context-bad")
                        .invalid()
                        .default_value("32k"),
                )
                .child(FieldDescription::new().child(c.invalid)),
        )
        .into_any_element()
}

fn compact(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    Stack::row()
        .cross(Cross::Center)
        .gap(Space::Sm)
        .child(FieldLabel::new().child(copy(lang).max_workers))
        .child(Input::new("input-max-workers").compact().default_value("3"))
        .into_any_element()
}

fn underline(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    labelled(
        "input-field-underline",
        c.server_name,
        Input::new("input-underline")
            .variant(InputVariant::Underline)
            .text_size(TextSize::Inherit)
            .placeholder(c.server_name),
    )
    .into_any_element()
}

fn quiet(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let search = copy(lang).search;
    Input::new("input-quiet")
        .variant(InputVariant::Quiet)
        .placeholder(search)
        .probe("input-quiet")
        .into_any_element()
}

fn inline_padding(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    labelled(
        "input-field-inline-padding",
        c.inline_padding,
        Input::new("input-inline-padding")
            .padding_inline(
                ds.len(Length::SpaceSm) - ds.len(Length::BorderHairline),
                px(32.),
            )
            .placeholder(c.search),
    )
    .into_any_element()
}
