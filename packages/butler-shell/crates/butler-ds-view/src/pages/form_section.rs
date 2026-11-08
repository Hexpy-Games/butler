//! FormSection.showcase.tsx: the section with and without a description, a description that
//! repeats the page (dropped), stacked sections, and a list section with a header action.
use butler_ds::tokens::Length;
use butler_ds::ui::blocks::form_section::{FormSection, FormSectionKind};
use butler_ds::ui::blocks::key_value_row::KeyValueRow;
use butler_ds::ui::blocks::settings_field::SettingsField;
use butler_ds::ui::blocks::settings_shell::{SettingsPageCopy, settings_page_provider};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::switch::Switch;
use butler_ds::ui::text::Input;
use gpui::{AnyElement, App, ElementId, IntoElement as _, ParentElement as _, Styled as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    general: &'static str,
    search: &'static str,
    search_description: &'static str,
    model: &'static str,
    name: &'static str,
    name_description: &'static str,
    name_value: &'static str,
    smart_groups: &'static str,
    smart_groups_description: &'static str,
    provider: &'static str,
    theme: &'static str,
    context: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            general: "General",
            search: "Search",
            search_description: "Configure web search providers and pre-search planning. Providers that need keys can store secrets here.",
            model: "Model settings",
            name: "Display name",
            name_description: "Shown in Butler messages.",
            name_value: "Butler",
            smart_groups: "Smart groups",
            smart_groups_description: "Automatically organize new conversations by topic.",
            provider: "Search provider",
            theme: "Home screen theme",
            context: "Context limit",
        },
        Copy {
            general: "일반",
            search: "검색",
            search_description: "웹 검색 제공자와 사전 검색 계획을 설정합니다. 키가 필요한 제공자는 여기에 비밀 값을 저장할 수 있습니다.",
            model: "모델 설정",
            name: "표시 이름",
            name_description: "버틀러 메시지에 표시됩니다.",
            name_value: "버틀러",
            smart_groups: "스마트 그룹",
            smart_groups_description: "새 대화를 주제별로 자동 정리합니다.",
            provider: "검색 제공자",
            theme: "홈 화면 테마",
            context: "컨텍스트 한도",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    let story = |name, render| Story { name, render };
    vec![
        story("Title and description above the card", described),
        story("Title only", title_only),
        story(
            "Description that repeats the page is dropped (the title stays)",
            repeats_page,
        ),
        story(
            "Stacked sections (header belongs to the card below)",
            stacked,
        ),
        story("Header action and list rows (kind list)", list),
    ]
}

/// A name input and a switch row, as the React `Fields`.
fn fields(c: &Copy, id: &'static str) -> [AnyElement; 2] {
    [
        SettingsField::new(c.name)
            .setting_id((ElementId::from(id), "name"))
            .description(c.name_description)
            .control(Input::new((ElementId::from(id), "name-input")).default_value(c.name_value))
            .into_any_element(),
        SettingsField::new(c.smart_groups)
            .setting_id((ElementId::from(id), "groups"))
            .description(c.smart_groups_description)
            .control(Switch::new((ElementId::from(id), "groups-switch")))
            .into_any_element(),
    ]
}

fn input_field(label: &'static str, id: &'static str, value: &'static str) -> AnyElement {
    SettingsField::new(label)
        .setting_id(id)
        .control(Input::new((ElementId::from(id), "input")).default_value(value))
        .into_any_element()
}

fn described(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    FormSection::new(c.search)
        .description(c.search_description)
        .holds_field()
        .children(fields(&c, "form-section-described"))
        .into_any_element()
}

fn title_only(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    FormSection::new(c.model)
        .holds_field()
        .children(fields(&c, "form-section-title-only"))
        .into_any_element()
}

fn repeats_page(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let section = FormSection::new(c.search)
        .description(c.search_description)
        .holds_field()
        .child(input_field(c.theme, "form-section-repeats-theme", "Bloom"));
    let page = SettingsPageCopy {
        title: Some(c.general.into()),
        description: Some(c.search_description.into()),
    };
    settings_page_provider(page, section).into_any_element()
}

fn stacked(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let gap = Ds::get(cx).len(Length::SettingsSectionGap);
    gpui::div()
        .flex()
        .flex_col()
        .gap(gap)
        .child(
            FormSection::new(c.general)
                .holds_field()
                .children(fields(&c, "form-section-stacked-general")),
        )
        .child(
            FormSection::new(c.search)
                .description(c.search_description)
                .holds_field()
                .child(input_field(
                    c.provider,
                    "form-section-stacked-provider",
                    "Tavily",
                )),
        )
        .child(FormSection::new(c.model).holds_field().child(input_field(
            c.context,
            "form-section-stacked-context",
            "258000",
        )))
        .into_any_element()
}

fn list(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    FormSection::new(c.model)
        .kind(FormSectionKind::List)
        .actions(
            Button::new("form-section-add")
                .size(Size::Sm)
                .variant(Variant::Outline)
                .text("+"),
        )
        .child(KeyValueRow::new("Model 5.1", "1.05M"))
        .child(KeyValueRow::new("Model 4.0", "200K"))
        .child(KeyValueRow::new("Local", "32K"))
        .into_any_element()
}
