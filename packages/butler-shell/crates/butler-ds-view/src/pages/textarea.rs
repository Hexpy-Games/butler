//! Textarea.showcase.tsx.
use butler_ds::ui::button::{Button, Size, Variant, container};
use butler_ds::ui::field::{Field, FieldDescription, FieldLabel};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::text::{TextSize, Textarea, TextareaVariant};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    persona: &'static str,
    persona_value: &'static str,
    persona_hint: &'static str,
    args: &'static str,
    args_hint: &'static str,
    args_value: &'static str,
    description: &'static str,
    description_value: &'static str,
    cancel: &'static str,
    save: &'static str,
    brief: &'static str,
    brief_hint: &'static str,
    brief_line: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            persona: "Persona",
            persona_value: "Direct and calm. Explain trade-offs briefly, ask before destructive changes, and keep replies in the user's language.",
            persona_hint: "How Butler presents itself and works with you",
            args: "Arguments",
            args_hint: "One per line",
            args_value: "--stdio\n--read-only",
            description: "Project description",
            description_value: "Butler desktop app: Electron shell, React UI and the Rust agent gateway.",
            cancel: "Cancel",
            save: "Save",
            brief: "Task brief",
            brief_hint: "Grows as you type, up to 12 lines",
            brief_line: "Check the release notes and the changed screens.",
        },
        Copy {
            persona: "페르소나",
            persona_value: "차분하고 직설적으로 말합니다. 장단점은 짧게 설명하고, 되돌릴 수 없는 변경 전에는 먼저 묻고, 사용자의 언어로 답합니다.",
            persona_hint: "버틀러가 자신을 표현하고 사용자와 협업하는 방식",
            args: "인자",
            args_hint: "한 줄에 하나씩 입력",
            args_value: "--stdio\n--read-only",
            description: "프로젝트 설명",
            description_value: "버틀러 데스크톱 앱: Electron 셸, React UI, Rust 에이전트 게이트웨이.",
            cancel: "취소",
            save: "저장",
            brief: "과제 설명",
            brief_hint: "입력하는 만큼 12줄까지 늘어납니다",
            brief_line: "릴리스 노트와 바뀐 화면을 확인합니다.",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Personalization field",
            render: personalization,
        },
        Story {
            name: "Placeholder (MCP arguments)",
            render: placeholder,
        },
        Story {
            name: "Inline edit (project description)",
            render: inline_edit,
        },
        Story {
            name: "Read-only and disabled",
            render: read_only,
        },
        Story {
            name: "Auto-grow (default variant)",
            render: auto_grow,
        },
        Story {
            name: "Underline · wrapping in-place entry",
            render: underline,
        },
    ]
}

fn personalization(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Field::new("textarea-field-persona")
        .child(FieldLabel::new().child(c.persona))
        .child(Textarea::new("textarea-persona").default_value(c.persona_value))
        .child(FieldDescription::new().child(c.persona_hint))
        .into_any_element()
}

fn placeholder(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Field::new("textarea-field-args")
        .child(FieldLabel::new().child(c.args))
        .child(Textarea::new("textarea-args").placeholder(c.args_hint))
        .into_any_element()
}

fn inline_edit(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Stack::new()
        .gap(Space::Sm)
        .child(Textarea::new("textarea-description").default_value(c.description_value))
        .child(
            container(Size::Sm)
                .child(
                    Button::new("textarea-cancel")
                        .size(Size::Sm)
                        .variant(Variant::Borderless)
                        .text(c.cancel),
                )
                .child(Button::new("textarea-save").size(Size::Sm).text(c.save)),
        )
        .into_any_element()
}

fn read_only(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Stack::new()
        .gap(Space::Sm)
        .child(
            Textarea::new("textarea-prompt")
                .rows(4)
                .read_only()
                .value(c.args_value),
        )
        .child(
            Textarea::new("textarea-persona-off")
                .disabled()
                .value(c.persona_value),
        )
        .into_any_element()
}

fn auto_grow(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let long = (1..=16)
        .map(|n| format!("{n}. {}", c.brief_line))
        .collect::<Vec<_>>()
        .join("\n");
    Stack::new()
        .gap(Space::Md)
        .child(
            Field::new("textarea-field-brief")
                .child(FieldLabel::new().child(c.brief))
                .child(
                    Textarea::new("textarea-brief")
                        .auto_grow()
                        .default_value(c.persona_value),
                )
                .child(FieldDescription::new().child(c.brief_hint)),
        )
        .child(
            Textarea::new("textarea-brief-long")
                .auto_grow()
                .default_value(long),
        )
        .into_any_element()
}

fn underline(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Textarea::new("textarea-underline")
        .variant(TextareaVariant::Underline)
        .text_size(TextSize::Label)
        .placeholder(c.description)
        .probe("textarea-underline")
        .into_any_element()
}
