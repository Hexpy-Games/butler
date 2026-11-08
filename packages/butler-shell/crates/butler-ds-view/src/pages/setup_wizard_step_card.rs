//! SetupWizardStepCard.showcase.tsx: the consent step, sign-in waiting (neutral notice), a stopped
//! step with retry (each on the light and dark focus shell), and the intro-to-steps flow
//! (`stepKey` swaps the card, `contentKey` fades the body between steps).
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::notice::{Notice, NoticeTone};
use butler_ds::ui::blocks::setup_wizard_shell::{
    ContentWidth, SetupWizardAnchor, SetupWizardContent, SetupWizardMark, SetupWizardProgress,
    SetupWizardShell, SetupWizardStep, SetupWizardVariant,
};
use butler_ds::ui::blocks::setup_wizard_step_card::{SetupWizardStepAction, SetupWizardStepCard};
use butler_ds::ui::blocks::wallpaper::WallpaperTone;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Cross, Inline, Space, Stack};
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::typo::{TextAlign, Tone, Typo};
use gpui::{
    AnyElement, App, Entity, IntoElement as _, ParentElement as _, SharedString, Styled as _,
    Window, div, px,
};

use super::{Story, sub};
use crate::copy::Lang;

/// The preview frame. // DS: SetupWizardShell.showcase.tsx (embedded min-height narrow)
const FRAME_HEIGHT: f32 = 640.;

struct Copy {
    steps: [&'static str; 4],
    back: &'static str,
    consent_title: &'static str,
    consent_body: &'static str,
    ready: &'static str,
    decline: &'static str,
    agree: &'static str,
    pick_title: &'static str,
    pick_body: &'static str,
    sign_in_title: &'static str,
    sign_in_body: &'static str,
    waiting: &'static str,
    reopen: &'static str,
    share_link: &'static str,
    cancel: &'static str,
    timed_out: &'static str,
    timed_out_body: &'static str,
    retry: &'static str,
    welcome: &'static str,
    welcome_body: &'static str,
    start: &'static str,
    next: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            steps: ["Welcome", "Consent", "Connect AI", "Finish"],
            back: "Back",
            consent_title: "Before you start",
            consent_body: "Butler can create, change and delete files and run commands on this computer.",
            ready: "Ready",
            decline: "Decline",
            agree: "Agree and continue",
            pick_title: "Which AI should Butler work with?",
            pick_body: "Pick one to get started. You can change it later in Settings.",
            sign_in_title: "Sign in to ChatGPT",
            sign_in_body: "Butler picks up automatically when you're done.",
            waiting: "Waiting for your browser",
            reopen: "Open browser again",
            share_link: "Copy link",
            cancel: "Cancel",
            timed_out: "Sign-in timed out",
            timed_out_body: "No answer from the browser. Try again.",
            retry: "Try again",
            welcome: "Welcome to Butler",
            welcome_body: "Butler works for you on this computer.",
            start: "Get started",
            next: "Next step",
        },
        Copy {
            steps: ["환영", "동의", "AI 연결", "마무리"],
            back: "이전",
            consent_title: "시작하기 전에 확인해 주세요",
            consent_body: "버틀러는 이 컴퓨터에서 파일을 만들고, 수정하고, 삭제하고, 명령어를 실행할 수 있습니다.",
            ready: "준비됨",
            decline: "동의하지 않음",
            agree: "동의하고 계속",
            pick_title: "어떤 AI와 일할까요?",
            pick_body: "하나만 고르면 바로 시작합니다. 나중에 설정에서 바꿀 수 있습니다.",
            sign_in_title: "ChatGPT에 로그인하세요",
            sign_in_body: "로그인을 마치면 버틀러가 자동으로 이어갑니다.",
            waiting: "브라우저에서 기다리는 중",
            reopen: "브라우저 다시 열기",
            share_link: "링크 복사",
            cancel: "취소",
            timed_out: "로그인 시간이 지났습니다",
            timed_out_body: "브라우저에서 응답이 없었습니다. 다시 시도하세요.",
            retry: "다시 시도",
            welcome: "반갑습니다",
            welcome_body: "버틀러는 이 컴퓨터에서 일을 대신합니다.",
            start: "시작하기",
            next: "다음 단계",
        },
    )
}

type Render = fn(Lang, &mut Window, &mut App) -> AnyElement;

fn story(name: &'static str, render: Render) -> Story {
    Story { name, render }
}

pub(super) fn stories() -> Vec<Story> {
    use WallpaperTone::{Dark, Light};
    vec![
        story("Consent step (light)", |l, _, cx| consent(l, Light, cx)),
        story("Consent step (dark)", |l, _, cx| consent(l, Dark, cx)),
        story("Sign-in waiting (neutral notice) (light)", |l, _, cx| {
            sign_in(l, Light, cx)
        }),
        story("Sign-in waiting (neutral notice) (dark)", |l, _, cx| {
            sign_in(l, Dark, cx)
        }),
        story("Stopped step with retry (light)", |l, _, _| {
            timed_out(l, Light)
        }),
        story("Stopped step with retry (dark)", |l, _, _| {
            timed_out(l, Dark)
        }),
        story("Intro → steps transition (stepKey, contentKey)", flow),
    ]
}

fn steps(c: &Copy) -> Vec<SetupWizardStep> {
    c.steps
        .iter()
        .map(|label| SetupWizardStep::new(*label, *label))
        .collect()
}

fn progress(c: &Copy, active: usize) -> SetupWizardProgress {
    SetupWizardProgress::new(steps(c), active)
}

/// The wide solid frame a step card sits in.
fn wide(card: impl gpui::IntoElement) -> SetupWizardContent {
    SetupWizardContent::new()
        .variant(SetupWizardVariant::Focus)
        .width(ContentWidth::Wide)
        .solid()
        .child(card)
}

/// `Frame`: the embedded focus shell, anchored to the top.
fn shell(id: &'static str, tone: WallpaperTone) -> SetupWizardShell {
    SetupWizardShell::new(id, "Butler")
        .variant(SetupWizardVariant::Focus)
        .anchor(SetupWizardAnchor::Top)
        .embedded()
        .tone(tone)
}

fn frame(shell: SetupWizardShell) -> AnyElement {
    div()
        .w_full()
        .h(px(FRAME_HEIGHT))
        .child(shell)
        .into_any_element()
}

fn prep(c: &Copy, cx: &App) -> AnyElement {
    Inline::new()
        .gap(Space::Xs)
        .child(icon(Icon::CheckIcon, IconSize::Sm, Ds::get(cx)))
        .child(Typo::caption(c.ready).tone(Tone::Success))
        .into_any_element()
}

fn consent(lang: Lang, tone: WallpaperTone, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let id = if tone == WallpaperTone::Dark {
        "swsc-consent-dark"
    } else {
        "swsc-consent"
    };
    let card = SetupWizardStepCard::new(id, c.consent_title)
        .progress(progress(&c, 1))
        .on_back(c.back, |_, _, _| {})
        .footer_start(prep(&c, cx))
        .action(SetupWizardStepAction::new(sub(id, "decline"), c.decline))
        .action(SetupWizardStepAction::new(sub(id, "agree"), c.agree).forward())
        .child(Typo::body(c.consent_body));
    frame(shell(id, tone).child(wide(card)))
}

fn sign_in(lang: Lang, tone: WallpaperTone, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let id = if tone == WallpaperTone::Dark {
        "swsc-sign-in-dark"
    } else {
        "swsc-sign-in"
    };
    let ds = Ds::get(cx);
    let links = Inline::new()
        .gap(Space::Md)
        .wrap(false)
        .child(
            Button::new(sub(id, "reopen"))
                .variant(Variant::Inline)
                .size(Size::Sm)
                .icon_start(icon(Icon::Globe2, IconSize::Sm, ds))
                .text(c.reopen),
        )
        .child(
            Button::new(sub(id, "copy"))
                .variant(Variant::Inline)
                .size(Size::Sm)
                .icon_start(icon(Icon::Copy, IconSize::Sm, ds))
                .text(c.share_link),
        );
    let card = SetupWizardStepCard::new(id, c.sign_in_title)
        .description(c.sign_in_body)
        .progress(progress(&c, 2))
        .on_back(c.back, |_, _, _| {})
        .action(SetupWizardStepAction::new(sub(id, "cancel"), c.cancel))
        .child(
            Notice::new(NoticeTone::Neutral, c.waiting)
                .icon(Spinner::new(sub(id, "spin")).size(14.))
                .action(links),
        );
    frame(shell(id, tone).child(wide(card)))
}

fn timed_out(lang: Lang, tone: WallpaperTone) -> AnyElement {
    let c = copy(lang);
    let id = if tone == WallpaperTone::Dark {
        "swsc-stopped-dark"
    } else {
        "swsc-stopped"
    };
    let card = SetupWizardStepCard::new(id, c.timed_out)
        .description(c.timed_out_body)
        .progress(progress(&c, 2))
        .on_back(c.back, |_, _, _| {})
        .action(SetupWizardStepAction::new(sub(id, "retry"), c.retry).forward());
    frame(shell(id, tone).child(wide(card)))
}

/// Moves the flow to `next`, remembering the step it leaves.
fn go(state: &Entity<(usize, usize)>, next: usize) -> impl Fn(&mut App) + 'static {
    let state = state.clone();
    move |cx| {
        state.update(cx, |state, cx| {
            *state = (state.1, next);
            cx.notify();
        });
    }
}

/// Step `index`: 0 is the intro (420px), 1 to 3 are step cards (520px).
fn flow_card(c: &Copy, index: usize, state: &Entity<(usize, usize)>) -> AnyElement {
    let id = "swsc-flow";
    if index == 0 {
        let start = go(state, 1);
        return SetupWizardContent::new()
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
                    .text(c.start)
                    .on_click(move |_, _, cx| start(cx)),
            )
            .into_any_element();
    }
    let (title, description) = match index {
        1 => (c.consent_title, None),
        2 => (c.pick_title, Some(c.pick_body)),
        _ => (c.sign_in_title, None),
    };
    let (back, next) = (go(state, index - 1), go(state, (index + 1) % 4));
    let mut card = SetupWizardStepCard::new(id, title)
        .content_key(SharedString::from(index.to_string()))
        .progress(progress(c, index))
        .on_back(c.back, move |_, _, cx| back(cx))
        .action(
            SetupWizardStepAction::new(sub(id, "next"), c.next)
                .forward()
                .on_click(move |_, _, cx| next(cx)),
        );
    if let Some(description) = description {
        card = card.description(description);
    }
    wide(card).into_any_element()
}

/// Intro to steps: `stepKey` swaps the card, `contentKey` fades the body between steps.
fn flow(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let state = window.use_keyed_state("swsc-flow-step", cx, |_, _| (0_usize, 0_usize));
    let (before, now) = *state.read(cx);
    let key = |index: usize| if index == 0 { "intro" } else { "steps" };
    let mut stage = shell("swsc-flow-shell", WallpaperTone::Light)
        .step_key(key(now))
        .child(flow_card(&c, now, &state));
    if key(before) != key(now) {
        stage = stage.leaving(flow_card(&c, before, &state));
    }
    frame(stage)
}
