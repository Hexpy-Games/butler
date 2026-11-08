//! SettingsField.showcase.tsx: label, description, control and meta; a switch stacked under its
//! copy; an error under the control; the field ramp inside a FormSection card.
use butler_ds::ui::blocks::form_section::FormSection;
use butler_ds::ui::blocks::settings_field::SettingsField;
use butler_ds::ui::switch::Switch;
use butler_ds::ui::text::Input;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    name: &'static str,
    name_description: &'static str,
    name_value: &'static str,
    meta: &'static str,
    smart_groups: &'static str,
    smart_groups_description: &'static str,
    timezone: &'static str,
    section: &'static str,
    port: &'static str,
    port_description: &'static str,
    port_error: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            name: "Display name",
            name_description: "Shown in Butler messages.",
            name_value: "Butler",
            meta: "Saved locally",
            smart_groups: "Smart groups",
            smart_groups_description: "Automatically organize new conversations by topic. Manually moved conversations stay where you put them.",
            timezone: "Timezone",
            section: "General",
            port: "Port",
            port_description: "Local port for the web app.",
            port_error: "Enter a number from 1024 to 65535.",
        },
        Copy {
            name: "표시 이름",
            name_description: "버틀러 메시지에 표시됩니다.",
            name_value: "버틀러",
            meta: "로컬에 저장됨",
            smart_groups: "스마트 그룹",
            smart_groups_description: "새 대화를 주제별로 자동 정리합니다. 직접 옮긴 대화는 옮긴 자리에 그대로 둡니다.",
            timezone: "시간대",
            section: "일반",
            port: "포트",
            port_description: "웹 앱이 쓰는 로컬 포트입니다.",
            port_error: "1024부터 65535까지의 숫자를 입력하세요.",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Label, description, control, meta",
            render: basic,
        },
        Story {
            name: "Switch stacks under its copy",
            render: switch,
        },
        Story {
            name: "Error under the control",
            render: error,
        },
        Story {
            name: "Field ramp inside a section card",
            render: ramp,
        },
    ]
}

fn name_field(c: &Copy, id: &'static str) -> SettingsField {
    SettingsField::new(c.name)
        .description(c.name_description)
        .control(Input::new(id).default_value(c.name_value))
}

fn basic(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    name_field(&c, "field-name")
        .meta_text(c.meta)
        .into_any_element()
}

fn switch(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    SettingsField::new(c.smart_groups)
        .description(c.smart_groups_description)
        .control(Switch::new("field-groups"))
        .into_any_element()
}

fn error(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    SettingsField::new(c.port)
        .description(c.port_description)
        .control(Input::new("field-port").default_value("80").invalid())
        .error(c.port_error)
        .into_any_element()
}

fn ramp(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    FormSection::new(c.section)
        .holds_field()
        .child(
            SettingsField::new(c.smart_groups)
                .description(c.smart_groups_description)
                .control(Switch::new("ramp-groups")),
        )
        .child(name_field(&c, "ramp-name"))
        .child(
            SettingsField::new(c.timezone)
                .control(Input::new("ramp-timezone").default_value("Asia/Seoul")),
        )
        .into_any_element()
}
