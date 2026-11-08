//! `UsageImagesSection.tsx`: images generated and edited per image model.
use butler_ds::ui::animated_number::grouped;
use butler_ds::ui::blocks::settings_section::{
    SettingsSection, SettingsSectionKind, SettingsSectionState,
};
use butler_ds::ui::context::Lang;
use butler_ds::ui::layout::{Basis, Cross, Inline, MinWidth, Space, Stack, WithItem as _};
use butler_ds::ui::segmented_control::{Choice, SegmentedControl};
use butler_ds::ui::typo::{Typo, Weight};
use gpui::{AnyElement, Context, IntoElement as _, ParentElement as _};

use super::UsagePage;
use super::copy::{Words, words};
use super::load::VISIBILITY_DAYS;
use super::wire::ImageValues;
use crate::ui::settings::controls::provider_mark;

/// The image models' price: "—", "<$0.01" or dollars and cents.
fn price(cost: Option<f64>) -> String {
    match cost {
        None => "—".to_owned(),
        Some(cost) if cost > 0. && cost < 0.005 => "<$0.01".to_owned(),
        Some(cost) => {
            let text = format!("{:.2}", cost.max(0.));
            let (whole, fraction) = text.split_once('.').unwrap_or((&text, "00"));
            format!("${}.{fraction}", grouped(whole.parse().unwrap_or(0.)))
        }
    }
}

/// A right-aligned cell of the table.
fn cell(content: impl gpui::IntoElement) -> AnyElement {
    Stack::new()
        .cross(Cross::End)
        .basis(Basis::Xs)
        .child(content)
        .into_any_element()
}

/// `ImageUsageCells`
fn values_cells(values: &ImageValues) -> [AnyElement; 3] {
    [
        cell(Typo::text(grouped(values.generated)).tabular()),
        cell(Typo::text(grouped(values.edited)).tabular()),
        cell(Typo::text(price(values.estimated_usd)).tabular()),
    ]
}

fn table_row(first: AnyElement, values: &ImageValues) -> AnyElement {
    Stack::row()
        .gap(Space::Md)
        .cross(Cross::Center)
        .child(Stack::new().grow().min_width(MinWidth::Zero).child(first))
        .children(values_cells(values))
        .into_any_element()
}

fn header_row(words: &Words) -> AnyElement {
    let head = |label: &'static str| cell(Typo::text(label).weight(Weight::Medium));
    Stack::row()
        .gap(Space::Md)
        .child(Stack::new().grow().min_width(MinWidth::Zero))
        .child(head(words.images_generated))
        .child(head(words.images_edited))
        .child(head(words.images_cost))
        .into_any_element()
}

impl UsagePage {
    /// `useImageUsage().visible`: an image model is selected, or the last 30 days used one.
    fn images_visible(&self) -> bool {
        self.images.as_ref().is_some_and(|snapshot| {
            snapshot.selected
                || snapshot
                    .ranges
                    .get(&VISIBILITY_DAYS)
                    .is_some_and(|view| !view.models.is_empty())
        })
    }

    pub(super) fn images_section(
        &self,
        lang: Lang,
        cx: &mut Context<Self>,
    ) -> Option<SettingsSection> {
        if !self.images_visible() {
            return None;
        }
        let words = words(lang);
        let view = self
            .images
            .as_ref()
            .and_then(|snapshot| snapshot.ranges.get(&self.image_days));
        let state = if self.image_error {
            SettingsSectionState::Error
        } else if view.is_none() {
            SettingsSectionState::Loading
        } else {
            SettingsSectionState::Ready
        };
        let page = cx.entity().downgrade();
        let period = SegmentedControl::new(
            "usage-image-period",
            format!("{}: {}", words.images_title, words.period),
            self.image_days.to_string(),
        )
        .options([Choice::new("7", words.week), Choice::new("30", words.month)])
        .on_value_change(move |value, _, cx| {
            if let Ok(days) = value.parse() {
                let _ = page.update(cx, |this, cx| this.set_image_days(days, cx));
            }
        });
        let mut body = Stack::new()
            .gap(Space::Md)
            .child(Inline::new().child(period));
        if let Some(view) = view {
            let mut table = Stack::new().gap(Space::Sm).child(header_row(words));
            for model in &view.models {
                let name = Stack::row()
                    .gap(Space::Sm)
                    .cross(Cross::Center)
                    .wrap(false)
                    .child(provider_mark(&model.provider_id, None, false))
                    .child(Typo::text(model.display_name.clone()));
                table = table.child(table_row(name.into_any_element(), &model.values));
            }
            let total = Typo::text(words.images_total).weight(Weight::Medium);
            body = body.child(table.child(table_row(total.into_any_element(), &view.total)));
        }
        Some(
            SettingsSection::new(
                "usage-images",
                SettingsSectionKind::Status,
                words.images_title,
            )
            .state(state)
            .error_message(words.usage_failed)
            .on_retry(cx.listener(|this, _, _, cx| this.refresh(cx)))
            .child(body),
        )
    }
}
