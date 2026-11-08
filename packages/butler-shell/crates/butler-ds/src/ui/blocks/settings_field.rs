//! DS SettingsField (SettingsField.tsx / SettingsField.module.css): a settings row. Every control,
//! switches included, stacks under its copy: label, description, then the control column
//! (control, live state, error, meta). There is no inline layout. `SettingsFieldGroup` spaces
//! fields that show or hide together by the field gap.
use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement, ParentElement, RenderOnce,
    SharedString, Styled as _, Window, div, px,
};

use crate::tokens::{Color, Length};
use crate::ui::context::Ds;
use crate::ui::field::FieldError;
use crate::ui::label::Label;
use crate::ui::strut;
use crate::ui::typo::{Tone, Typo};

/// `.copy { max-width: 38rem }`.
const COPY_MAX_WIDTH: f32 = 38. * 16.; // DS: SettingsField.module.css:20
/// `.control { width: min(100%, 460px) }`.
const CONTROL_MAX_WIDTH: f32 = 460.; // DS: SettingsField.module.css:26

/// `controlWidth`: `Default` is at most 460px wide, `Full` fills the row.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ControlWidth {
    #[default]
    Default,
    Full,
}

/// The meta line: a caption-type text, or an element (a `MetaList`).
enum Meta {
    Text(SharedString),
    Element(AnyElement),
}

#[derive(IntoElement)]
pub struct SettingsField {
    label: SharedString,
    description: Option<SharedString>,
    control: Option<AnyElement>,
    error: Option<SharedString>,
    after_control: Option<AnyElement>,
    meta: Option<Meta>,
    control_width: ControlWidth,
    setting_id: Option<ElementId>,
}

impl SettingsField {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
            description: None,
            control: None,
            error: None,
            after_control: None,
            meta: None,
            control_width: ControlWidth::Default,
            setting_id: None,
        }
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn control(mut self, control: impl IntoElement) -> Self {
        self.control = Some(control.into_any_element());
        self
    }

    /// A localized validation message under the control. The caller also marks the control
    /// invalid (`Input::invalid`).
    pub fn error(mut self, error: impl Into<SharedString>) -> Self {
        self.error = Some(error.into());
        self
    }

    /// Directly under the control: its live state (progress, a result line) or a small action on
    /// its value (Cancel, Remove key).
    pub fn after_control(mut self, element: impl IntoElement) -> Self {
        self.after_control = Some(element.into_any_element());
        self
    }

    /// Facts about the setting as one line of caption text, last in the control column.
    pub fn meta_text(mut self, text: impl Into<SharedString>) -> Self {
        self.meta = Some(Meta::Text(text.into()));
        self
    }

    /// Facts about the setting as an element (a `MetaList`), last in the control column.
    pub fn meta(mut self, element: impl IntoElement) -> Self {
        self.meta = Some(Meta::Element(element.into_any_element()));
        self
    }

    pub fn control_width(mut self, width: ControlWidth) -> Self {
        self.control_width = width;
        self
    }

    /// The stable setting id (`data-setting-id`), used as the element id.
    pub fn setting_id(mut self, id: impl Into<ElementId>) -> Self {
        self.setting_id = Some(id.into());
        self
    }
}

impl RenderOnce for SettingsField {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let ds = Ds::get(cx);
        let control_gap = ds.len(Length::SettingsFieldControlGap);
        let mut copy = div()
            .flex()
            .flex_col()
            .min_w_0()
            .max_w(px(COPY_MAX_WIDTH))
            .gap(ds.len(Length::SettingsFieldCopyGap))
            .child(Label::new().child(self.label));
        if let Some(description) = self.description {
            copy = copy.child(Typo::caption(description).tone(Tone::Secondary));
        }
        let mut control = div()
            .flex()
            .flex_col()
            .min_w_0()
            .gap(control_gap)
            .text_color(ds.color(Color::TextTertiary))
            .w_full();
        if self.control_width == ControlWidth::Default {
            control = control.max_w(px(CONTROL_MAX_WIDTH));
        }
        let parts = [self.control, self.after_control];
        for part in parts.into_iter().flatten() {
            control = control.child(strut::flex_scope(true, part));
        }
        if let Some(error) = self.error {
            control = control.child(strut::flex_scope(true, FieldError::new().child(error)));
        }
        match self.meta {
            Some(Meta::Text(text)) => {
                control = control.child(Typo::caption(text).tone(Tone::Tertiary));
            }
            Some(Meta::Element(element)) => {
                control = control.child(strut::flex_scope(true, element));
            }
            None => {}
        }
        let field = div()
            .flex()
            .flex_col()
            .items_stretch()
            .w_full()
            .min_w_0()
            .gap(control_gap)
            .child(strut::flex_scope(true, copy))
            .child(strut::flex_scope(true, control));
        match self.setting_id {
            Some(id) => field.id(id).into_any_element(),
            None => field.into_any_element(),
        }
    }
}

/// Fields that show or hide together and need their own element: spaced by the field gap, like
/// the section card does for fields placed directly in it.
#[derive(IntoElement, Default)]
pub struct SettingsFieldGroup {
    children: Vec<AnyElement>,
}

impl SettingsFieldGroup {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ParentElement for SettingsFieldGroup {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.children.extend(elements);
    }
}

impl RenderOnce for SettingsFieldGroup {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .min_w_0()
            .gap(Ds::get(cx).len(Length::SettingsFieldGap))
            .children(self.children)
    }
}
