//! The story list of the ComposerQuestionPanel showcase.
use butler_ds::ui::blocks::composer_question_panel::PanelState;

use super::conversation;
use super::fixtures::Kind;
use super::run::{demo, run};
use crate::pages::Story;

/// Single, multiple and text questions.
fn choice_stories() -> Vec<Story> {
    vec![
        Story {
            name: "Single choice · recommended focus · Other",
            render: |l, w, c| {
                run(
                    l,
                    demo("cq-single", Kind::Single, PanelState::Open, 0),
                    w,
                    c,
                )
            },
        },
        Story {
            name: "Multiple choice · scroll fades",
            render: |l, w, c| run(l, demo("cq-multi", Kind::Multi, PanelState::Open, 0), w, c),
        },
        Story {
            name: "Short text",
            render: |l, w, c| run(l, demo("cq-text", Kind::Text, PanelState::Open, 0), w, c),
        },
    ]
}

/// Several questions, the review and the keyboard.
fn flow_stories() -> Vec<Story> {
    vec![
        Story {
            name: "Three questions · Tabs · review",
            render: |l, w, c| {
                run(
                    l,
                    demo("cq-three", Kind::Schedule, PanelState::Open, 1),
                    w,
                    c,
                )
            },
        },
        Story {
            name: "Onboarding · new chat first turn",
            render: |l, w, c| {
                run(
                    l,
                    demo("cq-onboarding", Kind::Onboarding, PanelState::Open, 0),
                    w,
                    c,
                )
            },
        },
        Story {
            name: "Four questions · partial answers",
            render: |l, w, c| run(l, demo("cq-four", Kind::Four, PanelState::Open, 0), w, c),
        },
        Story {
            name: "Keyboard · focus panel to start",
            render: |l, w, c| {
                run(
                    l,
                    demo("cq-keyboard", Kind::Single, PanelState::Open, 0),
                    w,
                    c,
                )
            },
        },
        Story {
            name: "Review",
            render: |l, w, c| {
                run(
                    l,
                    demo("cq-review", Kind::Onboarding, PanelState::Open, 3),
                    w,
                    c,
                )
            },
        },
    ]
}

/// The panel states.
fn state_stories() -> Vec<Story> {
    vec![
        Story {
            name: "Submitting",
            render: |l, w, c| {
                run(
                    l,
                    demo("cq-submitting", Kind::Onboarding, PanelState::Submitting, 3),
                    w,
                    c,
                )
            },
        },
        Story {
            name: "Error · retry",
            render: |l, w, c| run(l, demo("cq-error", Kind::Text, PanelState::Error, 0), w, c),
        },
        Story {
            name: "Collapsed · answer by message",
            render: |l, w, c| {
                run(
                    l,
                    demo("cq-collapsed", Kind::Single, PanelState::Collapsed, 0),
                    w,
                    c,
                )
            },
        },
        Story {
            name: "Working · disabled",
            render: |l, w, c| {
                run(
                    l,
                    demo("cq-working", Kind::Single, PanelState::Working, 0),
                    w,
                    c,
                )
            },
        },
    ]
}

/// `placement="conversation"`.
fn conversation_stories() -> Vec<Story> {
    vec![
        Story {
            name: "In conversation · single choice",
            render: |l, w, c| conversation(l, "cq-conv-single", Kind::Single, w, c),
        },
        Story {
            name: "In conversation · three questions",
            render: |l, w, c| conversation(l, "cq-conv-three", Kind::Schedule, w, c),
        },
    ]
}

pub(crate) fn stories() -> Vec<Story> {
    [
        choice_stories(),
        flow_stories(),
        state_stories(),
        conversation_stories(),
    ]
    .concat()
}
