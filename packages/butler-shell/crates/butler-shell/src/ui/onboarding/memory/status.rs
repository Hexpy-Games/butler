//! `MemoryModelStatus`: the memory model download under the AI step and the settings Memory
//! switch. Optional preparation; it never changes setup eligibility, and shows only for a chosen
//! download that is not ready.
use std::rc::Rc;

use butler_ds::tokens::Color;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_slot::{IconSlot, SlotSize};
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{
    AnyElement, App, IntoElement, ParentElement as _, RenderOnce, Styled as _, Window, div,
};
use serde_json::Value;

use super::copy::{Words, words};
use crate::ui::Icon;
use crate::ui::onboarding::readiness::MemoryModel;

/// What Retry runs.
pub(crate) type Retry = Rc<dyn Fn(&mut Window, &mut App)>;

/// `MemoryModelProgress` from a `memory_model` value of the readiness answer.
pub(crate) fn parse(value: &Value) -> Option<MemoryModel> {
    let bytes = |key: &str| value.get(key).and_then(Value::as_u64).unwrap_or(0);
    Some(MemoryModel {
        state: value.get("state")?.as_str()?.to_owned().into(),
        bytes_done: bytes("bytes_done"),
        bytes_total: bytes("bytes_total"),
        reason: value
            .get("reason")
            .and_then(Value::as_str)
            .map(|reason| reason.to_owned().into()),
    })
}

/// `Math.round(bytes / 1_000_000)`
pub(crate) fn megabytes(bytes: u64) -> u64 {
    bytes.saturating_add(500_000) / 1_000_000
}

/// The download's status with Retry, while there is one to show.
pub(crate) fn memory_status(
    model: Option<&MemoryModel>,
    lang: Lang,
    retry: Retry,
) -> Option<AnyElement> {
    let model = model.filter(|model| !matches!(&*model.state, "ready" | "unset" | "off"))?;
    Some(
        Status {
            model: model.clone(),
            copy: words(lang),
            retry,
        }
        .into_any_element(),
    )
}

#[derive(IntoElement)]
struct Status {
    model: MemoryModel,
    copy: &'static Words,
    retry: Retry,
}

impl Status {
    fn reason(&self) -> &'static str {
        let code = self.model.reason.as_deref().unwrap_or_default();
        self.copy
            .reasons
            .iter()
            .find(|(key, _)| *key == code)
            .map_or(self.copy.reason_default, |(_, text)| text)
    }

    /// `Downloading memory model · 42% · 40 / 95 MB`, or the verifying / failed label.
    fn label(&self) -> String {
        let model = &self.model;
        match &*model.state {
            "failed" => self.copy.failed.to_owned(),
            "verifying" => self.copy.verifying.to_owned(),
            "downloading" => {
                let percent = model
                    .bytes_done
                    .saturating_mul(100)
                    .checked_div(model.bytes_total)
                    .unwrap_or(0);
                format!(
                    "{} · {percent}% · {} / {} MB",
                    self.copy.downloading,
                    megabytes(model.bytes_done),
                    megabytes(model.bytes_total),
                )
            }
            _ => self.copy.downloading.to_owned(),
        }
    }
}

impl RenderOnce for Status {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let failed = &*self.model.state == "failed";
        let tone = if failed {
            Tone::Danger
        } else {
            Tone::Secondary
        };
        let ds = Ds::get(cx);
        let mark = if failed {
            div()
                .text_color(ds.color(Color::Danger))
                .child(icon(Icon::AlertCircle, IconSize::Sm, ds))
                .into_any_element()
        } else {
            Spinner::new("memory-model-spinner")
                .size(14.)
                .into_any_element()
        };
        let mut text = Stack::new()
            .gap(Space::Xs)
            .child(Typo::caption(self.label()).tone(tone).tabular());
        if failed {
            text = text.child(Typo::caption(self.reason()).tone(Tone::Secondary));
        }
        let mut row = Stack::row()
            .gap(Space::Sm)
            .cross(Cross::Start)
            .child(IconSlot::new().size(SlotSize::Sm).min_line().child(mark))
            .child(text);
        if failed {
            let retry = self.retry;
            row = row.child(
                Button::new("memory-model-retry")
                    .size(Size::Xs)
                    .variant(Variant::Inline)
                    .text(self.copy.retry)
                    .on_click(move |_, window, cx| retry(window, cx)),
            );
        }
        row
    }
}
