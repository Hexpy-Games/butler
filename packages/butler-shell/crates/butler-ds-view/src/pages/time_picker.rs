//! TimePicker.showcase.tsx: the settings time field, the hour cycles of each language, the open
//! wheel columns (a typed off-step minute joins the list in order), and the disabled field.
//! CARVE-OUT(no-intl): React also shows de-DE; Rust has no Intl, so a language is ko or en and
//! the 24-hour sample is `hour_cycle(H23)` (en-GB's layout).
use butler_ds::ui::blocks::settings_field::SettingsField;
use butler_ds::ui::context::Lang as DsLang;
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::time_picker::{HourCycle, TimePicker};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Window};

use super::{Story, probe};
use crate::copy::Lang;

struct Copy {
    time: &'static str,
    hint: &'static str,
    pick: &'static str,
    h12: &'static str,
    h23: &'static str,
    ko: &'static str,
    off_step: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            time: "Time",
            hint: "Runs only while Butler is on.",
            pick: "Choose time",
            h12: "12-hour (en-US)",
            h23: "24-hour (en-GB)",
            ko: "Korean (ko-KR)",
            off_step: "A typed 04:07 joins the 5-minute list in order.",
        },
        Copy {
            time: "실행 시간",
            hint: "버틀러가 켜져 있을 때만 실행합니다.",
            pick: "시간 고르기",
            h12: "12시간제 (en-US)",
            h23: "24시간제 (en-GB)",
            ko: "한국어 (ko-KR)",
            off_step: "직접 입력한 04:07은 5분 단위 목록에 순서대로 들어갑니다.",
        },
    )
}

fn ds_lang(lang: Lang) -> DsLang {
    lang.pick(DsLang::En, DsLang::Ko)
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Settings time field",
            render: settings,
        },
        Story {
            name: "Locales: hour cycle, order and day period",
            render: locales,
        },
        Story {
            name: "Open: wheel columns",
            render: open,
        },
        Story {
            name: "Disabled",
            render: disabled,
        },
    ]
}

/// A controlled value held in the page's state.
fn held(
    id: &'static str,
    initial: &'static str,
    window: &mut Window,
    cx: &mut App,
) -> (
    SharedString,
    impl Fn(SharedString, &mut Window, &mut App) + 'static,
) {
    let state = window.use_keyed_state(id, cx, move |_, _| SharedString::from(initial));
    let value = state.read(cx).clone();
    (value, move |next, _: &mut Window, cx: &mut App| {
        state.update(cx, |value, cx| {
            *value = next;
            cx.notify();
        });
    })
}

fn settings(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let (value, change) = held("tp-settings", "04:00", window, cx);
    let field = SettingsField::new(c.time).description(c.hint).control(
        TimePicker::new("tp-settings-field", value.clone(), c.pick)
            .locale(ds_lang(lang))
            .on_value_change(change),
    );
    Stack::new()
        .child(field)
        .child(probe(format!("value-tp-settings-{value}")))
        .into_any_element()
}

fn locales(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let samples: [(&'static str, DsLang, HourCycle, &'static str); 3] = lang.pick(
        [
            ("tp-en", DsLang::En, HourCycle::H12, c.h12),
            ("tp-gb", DsLang::En, HourCycle::H23, c.h23),
            ("tp-ko", DsLang::Ko, HourCycle::H12, c.ko),
        ],
        [
            ("tp-ko", DsLang::Ko, HourCycle::H12, c.ko),
            ("tp-en", DsLang::En, HourCycle::H12, c.h12),
            ("tp-gb", DsLang::En, HourCycle::H23, c.h23),
        ],
    );
    let mut stack = Stack::new().gap(Space::Md);
    for (id, locale, cycle, caption) in samples {
        let (value, change) = held(id, "16:30", window, cx);
        stack = stack.child(
            Stack::new()
                .gap(Space::Xs)
                .child(Typo::caption(caption).tone(Tone::Secondary))
                .child(
                    TimePicker::new(id, value, c.pick)
                        .locale(locale)
                        .hour_cycle(cycle)
                        .on_value_change(change),
                ),
        );
    }
    stack.into_any_element()
}

fn open(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let (value, change) = held("tp-open", "04:07", window, cx);
    Stack::new()
        .gap(Space::Xs)
        .child(
            TimePicker::new("tp-open-field", value, c.pick)
                .locale(ds_lang(lang))
                .default_open()
                .on_value_change(change),
        )
        .child(Typo::caption(c.off_step).tone(Tone::Secondary))
        .into_any_element()
}

fn disabled(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    TimePicker::new("tp-disabled", "04:00", c.pick)
        .locale(ds_lang(lang))
        .disabled(true)
        .into_any_element()
}
