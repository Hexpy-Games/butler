//! SetupWizardShell.showcase.tsx. The backdrop is the riso print poster (the live wallpaper is
//! P6). The flow's step cards are SetupWizardStepCard. The morph and the ink intro are not reproduced: "Card morph", "Re-run entrance"
//! and the ink intro stories show the card swap (old card fades out, new card rises in), and the
//! `full` stories the re-run entrance. Frame height is the DS View's.
use butler_ds::ui::blocks::setup_wizard_shell::{
    ContentWidth, SetupWizardAnchor, SetupWizardContent, SetupWizardIntro, SetupWizardList,
    SetupWizardMark, SetupWizardProgress, SetupWizardShell, SetupWizardStep, SetupWizardVariant,
};
use butler_ds::ui::blocks::setup_wizard_step_card::{SetupWizardStepAction, SetupWizardStepCard};
use butler_ds::ui::blocks::wallpaper::WallpaperTone;
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::typo::{TextAlign, Tone, Typo};
use gpui::{
    AnyElement, App, Entity, IntoElement as _, ParentElement as _, Styled as _, Window, div, px,
};

use super::{Story, sub};
use crate::copy::Lang;

/// The preview frame. // DS: SetupWizardShell.showcase.tsx (embedded min-height narrow)
const FRAME_HEIGHT: f32 = 640.;

struct Copy {
    steps: [&'static str; 4],
    title: &'static str,
    body: &'static str,
    items: [&'static str; 3],
    back: &'static str,
    accept: &'static str,
    welcome: &'static str,
    welcome_body: &'static str,
    agree: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            steps: ["Language", "Safety", "Install", "Model"],
            title: "Safety",
            body: "Butler works on your computer with the access you allow.",
            items: [
                "Review commands before granting full access.",
                "Keep secrets out of shared projects.",
                "You can stop a worker whenever you need to.",
            ],
            back: "Back",
            accept: "Accept",
            welcome: "Welcome to Butler",
            welcome_body: "Butler works for you on this computer.",
            agree: "Agree and continue",
        },
        Copy {
            steps: ["언어", "안전", "설치", "모델"],
            title: "안전",
            body: "버틀러는 허용한 권한으로 컴퓨터에서 작업합니다.",
            items: [
                "전체 권한을 주기 전에 명령을 확인하세요.",
                "공유 프로젝트에 비밀 정보를 두지 마세요.",
                "언제든 워커를 멈출 수 있습니다.",
            ],
            back: "뒤로",
            accept: "동의",
            welcome: "반갑습니다",
            welcome_body: "버틀러는 이 컴퓨터에서 일을 대신합니다.",
            agree: "동의하고 계속",
        },
    )
}

fn steps(c: &Copy) -> Vec<SetupWizardStep> {
    c.steps
        .iter()
        .map(|label| SetupWizardStep::new(*label, *label))
        .collect()
}

pub(super) fn stories() -> Vec<Story> {
    use WallpaperTone::{Dark, Light};
    vec![
        Story {
            name: "Step (light backdrop)",
            render: |lang, _, _| wizard(lang, "swz-step-light", Light),
        },
        Story {
            name: "Step (dark backdrop)",
            render: |lang, _, _| wizard(lang, "swz-step-dark", Dark),
        },
        Story {
            name: "Focus (one column, light)",
            render: |lang, _, _| focus(lang, "swz-focus-light", Light, SetupWizardAnchor::Center),
        },
        Story {
            name: "Focus (one column, dark)",
            render: |lang, _, _| focus(lang, "swz-focus-dark", Dark, SetupWizardAnchor::Center),
        },
        Story {
            name: "Focus anchored to the top (light)",
            render: |lang, _, _| focus(lang, "swz-top-light", Light, SetupWizardAnchor::Top),
        },
        Story {
            name: "Focus anchored to the top (dark)",
            render: |lang, _, _| focus(lang, "swz-top-dark", Dark, SetupWizardAnchor::Top),
        },
        Story {
            name: "Card morph (every step change)",
            render: |lang, w, cx| flow(lang, "swz-morph-light", Light, None, w, cx),
        },
        Story {
            name: "Card morph (every step change, dark)",
            render: |lang, w, cx| flow(lang, "swz-morph-dark", Dark, None, w, cx),
        },
        Story {
            name: "Re-run entrance (intro=\"rerun\")",
            render: |lang, w, cx| {
                flow(
                    lang,
                    "swz-rerun",
                    Light,
                    Some(SetupWizardIntro::Rerun),
                    w,
                    cx,
                )
            },
        },
        Story {
            name: "Ink intro (intro=\"full\", first install)",
            render: |lang, w, cx| {
                flow(lang, "swz-full", Light, Some(SetupWizardIntro::Full), w, cx)
            },
        },
        Story {
            name: "Ink intro (intro=\"full\", dark)",
            render: |lang, w, cx| {
                flow(
                    lang,
                    "swz-full-dark",
                    Dark,
                    Some(SetupWizardIntro::Full),
                    w,
                    cx,
                )
            },
        },
        Story {
            name: "Step indicator (SetupWizardProgress)",
            render: |lang, _, _| {
                let c = copy(lang);
                SetupWizardProgress::new(steps(&c), 1).into_any_element()
            },
        },
    ]
}

fn frame(shell: SetupWizardShell) -> AnyElement {
    div()
        .w_full()
        .h(px(FRAME_HEIGHT))
        .child(shell)
        .into_any_element()
}

fn wizard(lang: Lang, id: &'static str, tone: WallpaperTone) -> AnyElement {
    let c = copy(lang);
    let list = SetupWizardList::new().children(
        c.items
            .iter()
            .map(|item| Typo::body(*item).into_any_element()),
    );
    let content = SetupWizardContent::new()
        .child(Typo::h3(c.title))
        .child(Typo::body(c.body))
        .child(list)
        .child(
            button::container(Size::Default)
                .child(
                    Button::new(sub(id, "back"))
                        .variant(Variant::Outline)
                        .text(c.back),
                )
                .child(Button::new(sub(id, "accept")).text(c.accept)),
        );
    frame(
        SetupWizardShell::new(id, "Butler")
            .embedded()
            .tone(tone)
            .active_index(1)
            .steps(steps(&c))
            .child(content),
    )
}

fn welcome(c: &Copy, id: &'static str, state: &Entity<(usize, usize)>) -> AnyElement {
    let go = step_to(state, 1);
    SetupWizardContent::new()
        .variant(SetupWizardVariant::Focus)
        .solid()
        .child(
            Stack::new()
                .cross(Cross::Center)
                .gap(Space::Md)
                .child(SetupWizardMark::new(sub(id, "mark")))
                .child(Typo::h3(c.welcome).align(TextAlign::Center))
                .child(
                    Typo::body(c.welcome_body)
                        .align(TextAlign::Center)
                        .tone(Tone::Secondary),
                ),
        )
        .child(
            Button::new(sub(id, "start"))
                .size(Size::Lg)
                .stretch()
                .text(c.agree)
                .on_click(move |_, _, cx| go(cx)),
        )
        .into_any_element()
}

/// A step card in the wide solid frame, as the React flow places it.
fn wide(card: SetupWizardStepCard) -> AnyElement {
    SetupWizardContent::new()
        .variant(SetupWizardVariant::Focus)
        .width(ContentWidth::Wide)
        .solid()
        .child(card)
        .into_any_element()
}

fn safety(c: &Copy, id: &'static str, state: &Entity<(usize, usize)>) -> AnyElement {
    let (back, accept) = (step_to(state, 0), step_to(state, 2));
    let list = SetupWizardList::new().children(
        c.items
            .iter()
            .map(|item| Typo::body(*item).into_any_element()),
    );
    wide(
        SetupWizardStepCard::new(sub(id, "safety"), c.title)
            .progress(SetupWizardProgress::new(steps(c), 1))
            .on_back(c.back, move |_, _, cx| back(cx))
            .action(
                SetupWizardStepAction::new(sub(id, "accept"), c.accept)
                    .forward()
                    .on_click(move |_, _, cx| accept(cx)),
            )
            .child(Typo::body(c.body))
            .child(list),
    )
}

fn install(c: &Copy, id: &'static str, state: &Entity<(usize, usize)>) -> AnyElement {
    let back = step_to(state, 1);
    wide(
        SetupWizardStepCard::new(sub(id, "install"), c.steps[2])
            .progress(SetupWizardProgress::new(steps(c), 2))
            .on_back(c.back, move |_, _, cx| back(cx)),
    )
}

/// Moves the flow to `next`, remembering the step it leaves.
fn step_to(state: &Entity<(usize, usize)>, next: usize) -> impl Fn(&mut App) + 'static {
    let state = state.clone();
    move |cx| {
        state.update(cx, |state, cx| {
            *state = (state.1, next);
            cx.notify();
        });
    }
}

fn card(c: &Copy, id: &'static str, step: usize, state: &Entity<(usize, usize)>) -> AnyElement {
    match step {
        1 => safety(c, id, state),
        2 => install(c, id, state),
        _ => welcome(c, id, state),
    }
}

/// The first-run flow: the 420px welcome card, the 520px safety step and a shorter install step.
/// Every Start, Accept and Back changes the step key, so the card swaps each time.
fn flow(
    lang: Lang,
    id: &'static str,
    tone: WallpaperTone,
    intro: Option<SetupWizardIntro>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let c = copy(lang);
    let state = window.use_keyed_state(sub(id, "step"), cx, |_, _| (0_usize, 0_usize));
    let (before, now) = *state.read(cx);
    let mut shell = SetupWizardShell::new(id, "Butler")
        .variant(SetupWizardVariant::Focus)
        .anchor(SetupWizardAnchor::Top)
        .embedded()
        .tone(tone)
        .step_key(format!("step-{now}"))
        .child(card(&c, id, now, &state));
    if before != now {
        shell = shell.leaving(card(&c, id, before, &state));
    }
    if let Some(intro) = intro {
        shell = shell.intro(intro);
    }
    frame(shell)
}

fn focus(
    lang: Lang,
    id: &'static str,
    tone: WallpaperTone,
    anchor: SetupWizardAnchor,
) -> AnyElement {
    let c = copy(lang);
    frame(
        SetupWizardShell::new(id, "Butler")
            .variant(SetupWizardVariant::Focus)
            .anchor(anchor)
            .embedded()
            .tone(tone)
            .child(
                SetupWizardContent::new()
                    .variant(SetupWizardVariant::Focus)
                    .solid()
                    .child(Typo::h3(c.welcome).align(TextAlign::Center))
                    .child(Typo::body(c.welcome_body).align(TextAlign::Center))
                    .child(
                        Button::new(sub(id, "agree"))
                            .size(Size::Lg)
                            .stretch()
                            .text(c.agree),
                    ),
            ),
    )
}
