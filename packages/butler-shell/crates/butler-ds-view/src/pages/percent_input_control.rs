//! PercentInputControl.showcase.tsx: the control in a SettingsField, as React does.
use butler_ds::ui::blocks::percent_input_control::PercentInputControl;
use butler_ds::ui::blocks::settings_field::SettingsField;
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
            label: "Local reasoning budget",
            description: "Share of the context a local model may spend on reasoning.",
        },
        Copy {
            label: "로컬 추론 예산",
            description: "로컬 모델이 추론에 쓸 수 있는 컨텍스트 비율입니다.",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "In a settings field",
            render: |lang, window, cx| budget("percent-field", None, false, lang, window, cx),
        },
        Story {
            name: "Bounded range (40–90%)",
            render: |lang, window, cx| {
                budget("percent-bounded", Some((40., 90.)), false, lang, window, cx)
            },
        },
        Story {
            name: "Disabled while saving",
            render: |lang, window, cx| budget("percent-disabled", None, true, lang, window, cx),
        },
    ]
}

fn budget(
    id: &'static str,
    range: Option<(f64, f64)>,
    disabled: bool,
    lang: Lang,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let c = copy(lang);
    let state = window.use_keyed_state((gpui::ElementId::from(id), "value"), cx, |_, _| 40.);
    let value = *state.read(cx);
    let mut control = PercentInputControl::new(id, value).on_commit(move |next, _, cx| {
        state.update(cx, |value, cx| {
            *value = next;
            cx.notify();
        });
        true
    });
    if let Some((min, max)) = range {
        control = control.min(min).max(max);
    }
    if disabled {
        control = control.disabled();
    }
    let field = SettingsField::new(c.label)
        .setting_id(id)
        .description(c.description)
        .control(control);
    gpui::div()
        .child(field)
        .child(probe(format!("value-{id}-{value:.0}")))
        .into_any_element()
}
