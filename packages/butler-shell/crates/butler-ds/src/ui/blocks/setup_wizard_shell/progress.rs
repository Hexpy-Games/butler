//! SetupWizardProgress (SetupWizardProgress.tsx / SetupWizardProgress.module.css): the numbered
//! step list. Every step is its number and label in the tertiary tone; the active one is primary
//! with a label-weight label. The list's accessible name (`ariaLabel`) has no gpui counterpart.
use gpui::{App, IntoElement, ParentElement as _, RenderOnce, SharedString, Window};

use crate::ui::layout::{Cross, Space, Stack};
use crate::ui::typo::{Tone, Typo, Weight};

/// One step: a stable id and the label shown after its number.
#[derive(Clone, Debug)]
pub struct SetupWizardStep {
    pub id: SharedString,
    pub label: SharedString,
}

impl SetupWizardStep {
    pub fn new(id: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
        }
    }
}

#[derive(IntoElement)]
pub struct SetupWizardProgress {
    steps: Vec<SetupWizardStep>,
    active_index: usize,
}

impl SetupWizardProgress {
    pub fn new(steps: impl IntoIterator<Item = SetupWizardStep>, active_index: usize) -> Self {
        Self {
            steps: steps.into_iter().collect(),
            active_index,
        }
    }
}

impl RenderOnce for SetupWizardProgress {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let active_index = self.active_index;
        let items = self.steps.into_iter().enumerate().map(|(index, step)| {
            let active = index == active_index;
            let tone = if active {
                Tone::Primary
            } else {
                Tone::Tertiary
            };
            let label = Typo::caption(step.label).tone(tone);
            let label = if active {
                label.weight(Weight::Medium)
            } else {
                label
            };
            Stack::row()
                .cross(Cross::Baseline)
                .gap(Space::Xs)
                .child(Typo::caption((index + 1).to_string()).tone(tone))
                .child(label)
        });
        Stack::row().wrap(true).gap(Space::Md).children(items)
    }
}
