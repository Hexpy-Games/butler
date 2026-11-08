//! DS SettingsActionField (SettingsActionField.tsx): a settings action row. Label, a one-line
//! description of the effect and its consequence, and the action (one Button, or a button
//! container for two actions on one subject) in the control slot under them. Facts the action
//! works on go in `details` above the button, progress in `after_control`, other facts in `meta`.
use gpui::{
    AnyElement, App, ElementId, IntoElement, ParentElement as _, RenderOnce, SharedString, Window,
};

use super::settings_field::SettingsField;
use crate::ui::layout::{Inline, Space, Stack};

#[derive(IntoElement)]
pub struct SettingsActionField {
    field: SettingsField,
    action: AnyElement,
    details: Option<AnyElement>,
}

impl SettingsActionField {
    /// `description` says what the action does and what it changes, in one short line.
    pub fn new(
        label: impl Into<SharedString>,
        description: impl Into<SharedString>,
        action: impl IntoElement,
    ) -> Self {
        Self {
            field: SettingsField::new(label).description(description),
            action: action.into_any_element(),
            details: None,
        }
    }

    /// Read-only facts the action is about (a subtle `SurfacePanel`), between the description and
    /// the action.
    pub fn details(mut self, details: impl IntoElement) -> Self {
        self.details = Some(details.into_any_element());
        self
    }

    pub fn error(mut self, error: impl Into<SharedString>) -> Self {
        self.field = self.field.error(error);
        self
    }

    pub fn after_control(mut self, element: impl IntoElement) -> Self {
        self.field = self.field.after_control(element);
        self
    }

    pub fn meta_text(mut self, text: impl Into<SharedString>) -> Self {
        self.field = self.field.meta_text(text);
        self
    }

    pub fn meta(mut self, element: impl IntoElement) -> Self {
        self.field = self.field.meta(element);
        self
    }

    pub fn setting_id(mut self, id: impl Into<ElementId>) -> Self {
        self.field = self.field.setting_id(id);
        self
    }
}

impl RenderOnce for SettingsActionField {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let control = match self.details {
            // Details, then the action, at the field's control gap (Stack "sm").
            Some(details) => Stack::new()
                .gap(Space::Sm)
                .child(details)
                .child(Inline::new().child(self.action))
                .into_any_element(),
            None => self.action,
        };
        self.field.control(control)
    }
}
