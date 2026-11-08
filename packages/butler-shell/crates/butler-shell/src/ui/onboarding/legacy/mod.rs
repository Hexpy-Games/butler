//! A pre-BTCC data folder (`LegacyDataRecovery`): the only screen; no Agent starts. The copy is
//! inline in Korean and English, as React has it, with its own language choice.
use butler_ds::ui::blocks::setup_wizard_shell::{
    SetupWizardContent, SetupWizardShell, SetupWizardVariant,
};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Lang;
use butler_ds::ui::field::{Field, FieldContent, FieldLabel};
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::native_select::{NativeSelect, Size as SelectSize};
use butler_ds::ui::typo::{TextAlign, Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use crate::lifecycle::runtime;
use crate::ui::theme::Platform;

struct Words {
    title: &'static str,
    body: &'static str,
    language: &'static str,
    folder: &'static str,
    restart: &'static str,
}

const KO: Words = Words {
    title: "이전 데이터 폴더예요",
    body: "이전 데이터는 그대로 보관돼요. 버틀러 0.0.20을 삭제한 뒤 .butler 폴더 이름을 바꾸고 다시 시작하세요.",
    language: "언어",
    folder: "폴더 열기",
    restart: "다시 시작",
};

const EN: Words = Words {
    title: "An older data folder",
    body: "Your old data is preserved. Uninstall Butler 0.0.20, rename the .butler folder, then restart.",
    language: "Language",
    folder: "Open folder",
    restart: "Restart",
};

fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}

pub(crate) fn screen(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let chosen = window.use_keyed_state("legacy-data-language", cx, |_, _| lang);
    let language = *chosen.read(cx);
    let text = words(language);
    let select = NativeSelect::new("legacy-data-language")
        .size(SelectSize::Sm)
        .stretch()
        .value(if language == Lang::Ko { "ko" } else { "en" })
        .option("ko", "한국어")
        .option("en", "English")
        .on_change(move |value, _, cx| {
            let next = if value == "ko" { Lang::Ko } else { Lang::En };
            chosen.update(cx, |chosen, cx| {
                *chosen = next;
                cx.notify();
            });
        });
    let data = runtime(cx).map(|runtime| runtime.read(cx).data.clone());
    let folder = Button::new("legacy-data-folder")
        .size(Size::Lg)
        .stretch()
        .text(text.folder)
        .on_click(move |_, _, cx| {
            if let Some(data) = &data {
                cx.open_with_system(data);
            }
        });
    let restart = Button::new("legacy-data-restart")
        .size(Size::Lg)
        .stretch()
        .variant(Variant::Secondary)
        .text(text.restart)
        .on_click(|_, _, cx| cx.restart());
    let heading = Stack::new()
        .cross(Cross::Center)
        .gap(Space::Md)
        .child(Typo::h3(text.title).align(TextAlign::Center))
        .child(
            Typo::body(text.body)
                .tone(Tone::Secondary)
                .align(TextAlign::Center),
        );
    let content = SetupWizardContent::new()
        .solid()
        .variant(SetupWizardVariant::Focus)
        .child(heading)
        .child(
            Field::new("legacy-data-field")
                .content(FieldContent::new().child(FieldLabel::new().child(text.language)))
                .child(select),
        )
        .child(button::container(Size::Lg).child(folder).child(restart));
    let mut shell = SetupWizardShell::new("legacy-data-recovery", "Butler")
        .variant(SetupWizardVariant::Focus)
        .child(content);
    if !matches!(Platform::host(), Platform::Mac) {
        shell = shell.window_controls(crate::ui::shell::window_controls(language));
    }
    shell.into_any_element()
}
