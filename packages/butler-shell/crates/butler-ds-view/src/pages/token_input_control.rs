//! TokenInputControl.showcase.tsx: the control in a SettingsField, as React does.
use butler_ds::ui::blocks::settings_field::SettingsField;
use butler_ds::ui::blocks::token_input_control::TokenInputControl;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::{Story, probe};
use crate::copy::Lang;

struct Copy {
    label: &'static str,
    description: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            label: "Context limit",
            description: "Maximum tokens Butler keeps in context. The model allows up to 400K.",
        },
        Copy {
            label: "컨텍스트 한도",
            description: "버틀러가 컨텍스트에 유지할 최대 토큰 수입니다. 모델 최대치는 400K입니다.",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Context limit",
            render: |lang, window, cx| context_limit("token-limit", 200_000., lang, window, cx),
        },
        Story {
            name: "At the model maximum",
            render: |lang, window, cx| context_limit("token-maximum", 400_000., lang, window, cx),
        },
    ]
}

fn context_limit(
    id: &'static str,
    initial: f64,
    lang: Lang,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let c = copy(lang);
    let state = window.use_keyed_state((gpui::ElementId::from(id), "value"), cx, move |_, _| {
        initial
    });
    let value = *state.read(cx);
    let control =
        TokenInputControl::new(id, value, 1000., 400_000.).on_commit(move |next, _, _, cx| {
            state.update(cx, |value, cx| {
                *value = next;
                cx.notify();
            });
        });
    let field = SettingsField::new(c.label)
        .setting_id(id)
        .description(c.description)
        .control(control);
    gpui::div()
        .child(field)
        .child(probe(format!("value-{id}-{value:.0}")))
        .into_any_element()
}
