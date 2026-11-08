//! SetupWizardMark (SetupWizardMark.tsx / SetupWizardIntro.module.css `.mark`): the plain Butler
//! logo in the 64px slot of the first-run welcome card. It stays still while Butler prepares.
//! The mark is the DS thinking mark at rest (the same traced logo); the ink intro that glides
//! the printed mark onto this slot is the wallpaper engine's (P6).
use gpui::{
    App, ElementId, IntoElement, ParentElement as _, RenderOnce, Styled as _, Window, div, px,
};

use crate::ui::thinking_mark::ButlerThinkingMark;

/// The slot's side. // DS: SetupWizardIntro.module.css:47
const SIDE: f32 = 64.;

#[derive(IntoElement)]
pub struct SetupWizardMark {
    id: ElementId,
}

impl SetupWizardMark {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self { id: id.into() }
    }
}

impl RenderOnce for SetupWizardMark {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        div()
            .flex_none()
            .size(px(SIDE))
            .child(ButlerThinkingMark::new(self.id))
    }
}
