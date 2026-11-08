//! DS FormSection (FormSection.tsx / FormSection.module.css): a settings section. The header (H4
//! title, 13px secondary description of at most 60ch, optional actions) sits above the card,
//! outside its surface; the bordered card is the section's only surface and holds the fields.
use gpui::{
    AnyElement, App, IntoElement, ParentElement, Pixels, RenderOnce, SharedString, Styled as _,
    Window, div, px,
};

use super::settings_shell::{repeats_settings_copy, settings_page};
use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::layout::{Cross, Justify, Stack};
use crate::ui::typo::Typo;

/// The card rhythm (`kind`): `Form` keeps the field gap; the others use the tighter row gap.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FormSectionKind {
    #[default]
    Form,
    /// Rows delimited by a hairline.
    List,
    Status,
    Info,
}

/// `flex: 1 1 18rem` of the header copy.
const COPY_BASIS: f32 = 288.; // DS: FormSection.module.css:25 (18rem at 16px)
/// `max-width: 60ch` of the description.
const DESCRIPTION_CH: f32 = 60.; // DS: FormSection.module.css:80

#[derive(IntoElement)]
pub struct FormSection {
    title: SharedString,
    description: Option<SharedString>,
    actions: Option<AnyElement>,
    kind: FormSectionKind,
    holds_field: bool,
    children: Vec<AnyElement>,
}

impl FormSection {
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            description: None,
            actions: None,
            kind: FormSectionKind::Form,
            holds_field: false,
            children: Vec::new(),
        }
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Header actions (add, refresh, filter, period); only on `List` and `Status`.
    pub fn actions(mut self, actions: impl IntoElement) -> Self {
        self.actions = Some(actions.into_any_element());
        self
    }

    pub fn kind(mut self, kind: FormSectionKind) -> Self {
        self.kind = kind;
        self
    }

    /// The card holds a settings field, so it keeps the field gap whatever its kind
    /// (React's `:has(> [data-settings-field])`).
    pub fn holds_field(mut self) -> Self {
        self.holds_field = true;
        self
    }
}

impl ParentElement for FormSection {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

/// The width of `0` at `size` in the inherited font, the `ch` unit.
fn ch(size: Pixels, window: &mut Window) -> Pixels {
    let font = window
        .text_system()
        .resolve_font(&window.text_style().font());
    window
        .text_system()
        .advance(font, size, '0')
        .map_or(size * 0.5, |advance| advance.width)
}

impl FormSection {
    fn header(&mut self, window: &mut Window, cx: &App) -> impl IntoElement + use<> {
        let ds = Ds::get(cx);
        // `useSettingsPage`: a description that repeats the page's is not rendered.
        let page = settings_page(cx).and_then(|page| page.description);
        let shown = self
            .description
            .take()
            .filter(|text| !repeats_settings_copy(Some(text), page.as_deref()));
        let size = ds.len(Length::FontSize2);
        let max = ch(size, window) * DESCRIPTION_CH;
        let copy = div()
            .flex()
            .flex_col()
            .flex_basis(px(COPY_BASIS))
            .flex_grow_1()
            .flex_shrink_1()
            .min_w_0()
            .gap(ds.len(Length::SettingsFieldCopyGap))
            .child(Typo::h4(self.title.clone()))
            .children(shown.map(|text| {
                div()
                    .max_w(max)
                    .text_color(ds.color(Color::TextSecondary))
                    .text_size(size)
                    .line_height(ds.len(Length::TypoLabelLineHeight))
                    .child(text)
            }));
        let actions = self.actions.take().map(|actions| {
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .justify_end()
                .gap(ds.len(Length::SpaceSm))
                .min_w_0()
                .ml_auto()
                .child(actions)
        });
        Stack::row()
            .wrap(true)
            .justify(Justify::Between)
            .cross(Cross::End)
            .child(copy)
            .children(actions)
    }
}

impl RenderOnce for FormSection {
    fn render(mut self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let header = self.header(window, cx);
        let tight = match self.kind {
            FormSectionKind::List => true,
            FormSectionKind::Status | FormSectionKind::Info => !self.holds_field,
            FormSectionKind::Form => false,
        };
        let gap = ds.len(if tight {
            Length::SpaceMd
        } else {
            Length::SettingsFieldGap
        });
        let list = self.kind == FormSectionKind::List;
        let rows = self.children.into_iter().enumerate().map(|(index, row)| {
            if list && index > 0 {
                div()
                    .w_full()
                    .pt(ds.len(Length::SpaceMd))
                    .border_t(ds.len(Length::BorderHairline))
                    .border_color(ds.color(Color::Line))
                    .child(row)
                    .into_any_element()
            } else {
                row
            }
        });
        let card = div()
            .flex()
            .flex_col()
            .min_w_0()
            .gap(gap)
            .p(ds.len(Length::SettingsSectionPadding))
            .border(ds.len(Length::BorderHairline))
            .border_color(ds.color(Color::Line))
            .rounded(ds.len(Length::RadiusPanel))
            .bg(ds.color(Color::SettingsPanelBg))
            .children(rows);
        div()
            .flex()
            .flex_col()
            .w_full()
            .min_w_0()
            .gap(ds.len(Length::SettingsSectionHeaderGap))
            .text_color(ds.color(Color::TextPrimary))
            .child(header)
            .child(card)
    }
}
