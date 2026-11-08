//! The step list (`FirstRunSteps.tsx`): the steps per mode, with the AI step's "2/3" substep.
use butler_ds::ui::blocks::setup_wizard_shell::{SetupWizardProgress, SetupWizardStep};
use gpui::{App, SharedString};

use super::copy::{Words, words};
use super::{Mode, Onboarding, Step};

/// `firstRunStepIds`.
fn ids(mode: Mode) -> &'static [Step] {
    match mode {
        Mode::FirstRun => &[
            Step::Welcome,
            Step::Consent,
            Step::Memory,
            Step::Connect,
            Step::Import,
            Step::Ready,
        ],
        Mode::Consent | Mode::Rerun => &[Step::Welcome, Step::Consent, Step::Connect, Step::Ready],
    }
}

fn label(step: Step, copy: &Words) -> &'static str {
    match step {
        Step::Welcome => copy.steps[0],
        Step::Consent => copy.steps[1],
        Step::Memory => copy.steps[2],
        Step::Connect => copy.steps[3],
        Step::Ready => copy.steps[4],
        Step::Import => copy.import,
    }
}

/// `firstRunSteps`; none on a consent renewal.
pub(super) fn progress(view: &Onboarding, cx: &App) -> Option<SetupWizardProgress> {
    if view.mode == Mode::Consent {
        return None;
    }
    let copy = words(view.lang);
    let step = view.step(cx);
    let substep = view.substep(cx);
    let steps = ids(view.mode).iter().map(|id| {
        let label = label(*id, copy);
        // CARVE-OUT(G-step-caption): React sets the count as a tertiary tabular caption after
        // the label; the DS step label is plain text.
        let label: SharedString = match substep {
            Some((index, total)) if *id == step => format!("{label} {index}/{total}").into(),
            _ => label.into(),
        };
        SetupWizardStep::new(id.id(), label)
    });
    let active = ids(view.mode)
        .iter()
        .position(|id| *id == step)
        .unwrap_or(0);
    Some(SetupWizardProgress::new(steps, active))
}
